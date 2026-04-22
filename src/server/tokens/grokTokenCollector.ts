import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { DATA_GENERAL_DIR, GROK_CDP_HOST, GROK_URL, ensureDirs } from "../config";
import { openGrokChrome } from "../chrome/grokChromeManager";
import { sessionTelemetry } from "./sessionTelemetry";

/**
 * Port of grok_api_text_to_video.auto_discover_statsig_headers.
 *
 * Grok.com uses a cookie session (already logged in within the profile) plus a special header:
 * - x-statsig-id: captured from outgoing requests when opening grok.com/imagine, or fallback to localStorage
 *
 * Cookies are sent automatically by Playwright when calling page.request.post → no need to track separately.
 */

const GROK_CACHE_FILE = path.join(DATA_GENERAL_DIR, "grok_cache.json");

export interface GrokHeaders {
  "x-statsig-id": string;
}

interface GrokCacheEntry {
  custom_headers: GrokHeaders;
  updated_at: string;
}

interface GrokCacheFile {
  profiles?: Record<string, GrokCacheEntry>;
}

function loadCacheFile(): GrokCacheFile {
  try {
    if (!existsSync(GROK_CACHE_FILE)) return {};
    return JSON.parse(readFileSync(GROK_CACHE_FILE, "utf-8")) as GrokCacheFile;
  } catch {
    return {};
  }
}

function saveCacheFile(cache: GrokCacheFile) {
  ensureDirs();
  writeFileSync(GROK_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export function getCachedGrokHeaders(profileName: string): GrokHeaders | null {
  const cache = loadCacheFile();
  const entry = cache.profiles?.[profileName];
  if (!entry?.custom_headers?.["x-statsig-id"]) return null;
  return entry.custom_headers;
}

export function setCachedGrokHeaders(profileName: string, headers: GrokHeaders) {
  const cache = loadCacheFile();
  cache.profiles = cache.profiles || {};
  cache.profiles[profileName] = {
    custom_headers: headers,
    updated_at: new Date().toISOString(),
  };
  saveCacheFile(cache);
}

export class GrokTokenCollector {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  public profileName: string;

  constructor(profileName: string) {
    this.profileName = profileName;
  }

  /**
   * Lightweight liveness check for the singleton — returns false when the
   * user has closed the Chrome window (CDP disconnected) so the caller can
   * reinit instead of blowing up on the next newPage() call.
   *
   * Note: this deliberately does NOT inspect `this.page`. A single tab can
   * die (user closed it, Chrome crashed the renderer, navigation dropped
   * the target) while the browser + context are still healthy; in that
   * case we want to swap the page handle in-place instead of tearing down
   * the whole CDP session. See `getLivePage()` for that path.
   */
  isAlive(): boolean {
    try {
      return !!(this.browser && this.browser.isConnected() && this.context);
    } catch {
      return false;
    }
  }

  async init() {
    const handle = await openGrokChrome({ profileName: this.profileName });
    const { chromium } = await import("playwright");
    this.browser = await chromium.connectOverCDP(`http://${GROK_CDP_HOST}:${handle.port}`);

    this.browser.on("disconnected", () => {
      console.warn("[Grok] Browser disconnected — invalidating singleton");
      sessionTelemetry.record({
        target: "grok",
        kind: "reset_collector",
        detail: "browser disconnected",
      });
      const store = getGrokStore();
      if (store.instance === this) {
        store.instance = null;
        store.initPromise = null;
      }
    });

    const contexts = this.browser.contexts();
    this.context = contexts[0] || (await this.browser.newContext());
    const pages = this.context.pages();
    this.page = pages[0] || (await this.context.newPage());

    try {
      const cdp = await this.context.newCDPSession(this.page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 80, top: 80, width: 1280, height: 860, windowState: "normal" },
      });
      await cdp.detach();
    } catch {
      // ignore
    }
  }

  getPage(): Page | null {
    return this.page;
  }

  /**
   * Return a Page handle that is guaranteed to be `!isClosed()` at the
   * moment of the call. If the cached `this.page` died (e.g. user closed
   * that specific tab, a navigation dropped the target, or the renderer
   * crashed), pick the next best Grok tab from the same browser context,
   * or open a fresh one. This is the single entry point every external
   * caller should use before `page.evaluate(...)` or `page.goto(...)`.
   *
   * Root cause this fixes: the symptom
   *   "page.evaluate: Target page, context or browser has been closed"
   * while the Grok window is still visibly open — the user just happened
   * to close the tab we cached at `init()`. Without this recovery, every
   * subsequent i2v / t2v would fail even though Chrome + the login are
   * fine; the user had to restart the dev server to clear the handle.
   */
  async getLivePage(): Promise<Page> {
    if (!this.browser || !this.context) {
      throw new Error("Grok collector chưa init");
    }
    const page = this.page;
    if (page && !page.isClosed()) return page;

    // Prefer an existing grok.com tab so we reuse the user's live
    // session/cookies instead of opening yet another window.
    const pages = this.context.pages();
    const grokPage = pages.find((p) => {
      try {
        return !p.isClosed() && /grok\.com/i.test(p.url());
      } catch {
        return false;
      }
    });
    if (grokPage) {
      console.warn(
        "[Grok] Cached page was stale — reclaiming existing Grok tab: " +
          grokPage.url(),
      );
      this.page = grokPage;
      return grokPage;
    }

    // No existing Grok tab → open a fresh one. autoDiscoverStatsig() or
    // the caller's `ensureGrokReady` will navigate it to /imagine as part
    // of the normal prep step.
    console.warn("[Grok] Cached page was stale — opening a new tab");
    const fresh = await this.context.newPage();
    this.page = fresh;
    return fresh;
  }

  async autoDiscoverStatsig(opts?: { force?: boolean; persist?: boolean }): Promise<GrokHeaders> {
    const { force = false, persist = true } = opts || {};

    if (!force) {
      const cached = getCachedGrokHeaders(this.profileName);
      if (cached) {
        sessionTelemetry.record({ target: "grok", kind: "cache_hit" });
        return cached;
      }
      sessionTelemetry.record({ target: "grok", kind: "cache_stale" });
    }

    // Use a live page handle — not `this.page` directly — so we don't
    // trip over a closed tab when the user killed the one we cached.
    const page = await this.getLivePage();

    const statsigPromise = new Promise<string>((resolve) => {
      const handler = (req: { headers(): Record<string, string> }) => {
        try {
          const h = req.headers();
          const v = h["x-statsig-id"];
          if (v) {
            page.off("request", handler);
            resolve(v);
          }
        } catch {
          // ignore
        }
      };
      page.on("request", handler);
    });

    try {
      await page.goto(`${GROK_URL.replace(/\/$/, "")}/imagine`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
    } catch {
      // ignore, may already be there
    }

    let statsig: string | null = null;
    try {
      statsig = await Promise.race([
        statsigPromise,
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12_000)),
      ]);
    } catch {
      statsig = null;
    }

    if (!statsig) {
      try {
        statsig = await page.evaluate(() => {
          try {
            return localStorage.getItem("x-statsig-id");
          } catch {
            return null;
          }
        });
      } catch {
        statsig = null;
      }
    }

    if (!statsig) {
      throw new Error("Không bắt được x-statsig-id của Grok. Hãy đảm bảo đã login Super Grok Heavy.");
    }

    const headers: GrokHeaders = { "x-statsig-id": statsig };
    if (persist) setCachedGrokHeaders(this.profileName, headers);
    return headers;
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
  }
}

// Stash on globalThis so the instance survives Next.js dev-mode HMR reloads
// (otherwise every code change would drop the reference and the next call
// would reconnect + spawn a duplicate Grok tab).
type GrokSingletonStore = {
  instance: GrokTokenCollector | null;
  initPromise: Promise<GrokTokenCollector> | null;
};
const GROK_GLOBAL_KEY = "__grokTokenCollectorSingleton__";
function getGrokStore(): GrokSingletonStore {
  const g = globalThis as unknown as Record<string, GrokSingletonStore | undefined>;
  if (!g[GROK_GLOBAL_KEY]) g[GROK_GLOBAL_KEY] = { instance: null, initPromise: null };
  return g[GROK_GLOBAL_KEY]!;
}

/**
 * Same rationale as VEO's dropStaleInstance — see that file for the full
 * explanation. Summary: an `instanceof` check against the *current* class
 * catches stale HMR prototypes in one principled step, while `isAlive()`
 * catches the legitimate "user closed Chrome while idle" case. Either
 * failure triggers a full reinit, not a per-method workaround.
 */
async function dropStaleGrokInstance(store: GrokSingletonStore): Promise<void> {
  const inst = store.instance;
  if (!inst) return;
  const isCurrentClass = inst instanceof GrokTokenCollector;
  const alive = isCurrentClass ? safeGrokIsAlive(inst) : false;
  if (isCurrentClass && alive) return;
  console.warn(
    `[Grok] Dropping cached collector (currentClass=${isCurrentClass}, alive=${alive}) — reinitialising`,
  );
  try {
    const closer = (inst as { close?: () => Promise<void> }).close;
    if (typeof closer === "function") await closer.call(inst);
  } catch {
    // ignore
  }
  store.instance = null;
  store.initPromise = null;
}

function safeGrokIsAlive(inst: GrokTokenCollector): boolean {
  try {
    return inst.isAlive();
  } catch {
    return false;
  }
}

export async function getGrokCollector(profileName: string): Promise<GrokTokenCollector> {
  const store = getGrokStore();
  await dropStaleGrokInstance(store);
  if (store.instance && store.instance.profileName === profileName) return store.instance;
  // Profile changed — close the previous instance cleanly before starting
  // a new one so we don't leak the CDP connection.
  if (store.instance && store.instance.profileName !== profileName) {
    try { await store.instance.close(); } catch { /* ignore */ }
    store.instance = null;
    store.initPromise = null;
  }
  if (store.initPromise) {
    try {
      const pending = await store.initPromise;
      if (
        pending instanceof GrokTokenCollector &&
        pending.profileName === profileName &&
        safeGrokIsAlive(pending)
      ) {
        return pending;
      }
    } catch {
      // fall through
    }
    await dropStaleGrokInstance(store);
  }
  store.initPromise = (async () => {
    const inst = new GrokTokenCollector(profileName);
    try {
      await inst.init();
      store.instance = inst;
      return inst;
    } finally {
      store.initPromise = null;
    }
  })();
  return store.initPromise;
}

export function resetGrokCollector() {
  const store = getGrokStore();
  if (store.instance) {
    store.instance.close().catch(() => undefined);
    store.instance = null;
  }
  store.initPromise = null;
}
