import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { DATA_GENERAL_DIR, GROK_CDP_HOST, GROK_URL, ensureDirs } from "../config";
import { openGrokChrome } from "../chrome/grokChromeManager";

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

  async init() {
    const handle = await openGrokChrome({ profileName: this.profileName });
    const { chromium } = await import("playwright");
    this.browser = await chromium.connectOverCDP(`http://${GROK_CDP_HOST}:${handle.port}`);
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

  async autoDiscoverStatsig(opts?: { force?: boolean; persist?: boolean }): Promise<GrokHeaders> {
    const { force = false, persist = true } = opts || {};

    if (!force) {
      const cached = getCachedGrokHeaders(this.profileName);
      if (cached) return cached;
    }

    if (!this.page) throw new Error("Grok page not ready");

    const statsigPromise = new Promise<string>((resolve) => {
      const handler = (req: { headers(): Record<string, string> }) => {
        try {
          const h = req.headers();
          const v = h["x-statsig-id"];
          if (v) {
            this.page?.off("request", handler);
            resolve(v);
          }
        } catch {
          // ignore
        }
      };
      this.page?.on("request", handler);
    });

    try {
      await this.page.goto(`${GROK_URL.replace(/\/$/, "")}/imagine`, {
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
        statsig = await this.page.evaluate(() => {
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

let _singleton: GrokTokenCollector | null = null;
let _initPromise: Promise<GrokTokenCollector> | null = null;

export async function getGrokCollector(profileName: string): Promise<GrokTokenCollector> {
  if (_singleton && _singleton.profileName === profileName) return _singleton;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (_singleton) await _singleton.close().catch(() => undefined);
    const inst = new GrokTokenCollector(profileName);
    try {
      await inst.init();
      _singleton = inst;
      return inst;
    } finally {
      _initPromise = null;
    }
  })();
  return _initPromise;
}

export function resetGrokCollector() {
  if (_singleton) {
    _singleton.close().catch(() => undefined);
    _singleton = null;
  }
  _initPromise = null;
}
