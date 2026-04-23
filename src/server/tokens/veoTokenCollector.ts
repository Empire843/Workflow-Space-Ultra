import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { DATA_GENERAL_DIR, VEO_CDP_HOST, VEO_FLOW_URL, RECAPTCHA_SITE_KEY, ensureDirs } from "../config";
import { openVeoChrome } from "../chrome/veoChromeManager";
import { STEALTH_SCRIPT } from "../chrome/stealthScript";
import {
  JobCancelledError,
  type ShouldCancel,
} from "../providers/cancellation";
import { sessionTelemetry } from "./sessionTelemetry";

/**
 * Hard cap on how long a single caller is willing to wait for the global
 * recaptcha lock to drain. Picked so that ~3 back-to-back captures (each
 * 40s first-use + some slack) can complete in order but a single broken
 * capture never permanently blocks the chain. If the wait hits this
 * ceiling we give up on the lock — a rare but necessary escape valve
 * during Chrome hangs.
 */
const RECAPTCHA_LOCK_MAX_WAIT_MS = 2 * 60_000;

/**
 * Port of A_workflow_get_token.py (TokenCollector).
 *
 * Captures 5 pieces of info from a logged-in labs.google/flow session:
 * - sessionId       : from POST /fx/api/trpc/general.submitBatchLog request body (event PINHOLE_CREATE_NEW_PROJECT)
 * - projectId       : from POST /fx/api/trpc/project.createProject request/response (result.data.json.result.projectId)
 * - access_token    : from GET /fx/_next/data/... response (pageProps.session.access_token)
 * - cookie          : from request headers when visiting labs.google/fx/*
 * - recaptcha_token : from /recaptcha/enterprise/reload?k=<site_key> response (marker ["rresp","..."])
 *
 * sessionId/projectId/accessToken/cookie are typically long-lived (refresh only on re-login).
 * Only recaptcha_token is short-lived and must be refreshed for every video create request.
 */

const TOKENS_CACHE_FILE = path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json");

export interface VeoAuth {
  sessionId: string;
  projectId: string;
  accessToken: string;
  cookie: string;
  updatedAt: string;
}

/**
 * Google OAuth access tokens are valid for ~1h. We treat anything older
 * than this as stale so the first request after a long idle period
 * doesn't have to eat a 401 before refreshing. A safe margin below the
 * real TTL keeps us from racing the token's actual expiry.
 */
const VEO_AUTH_CACHE_TTL_MS = 45 * 60_000;

export function loadCachedVeoAuth(): VeoAuth | null {
  try {
    ensureDirs();
    if (!existsSync(TOKENS_CACHE_FILE)) return null;
    const raw = readFileSync(TOKENS_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as VeoAuth;
    if (!parsed.sessionId || !parsed.projectId || !parsed.accessToken) return null;
    // Drop tokens older than the TTL. Without this check the server
    // would happily hand out a 2-hour-old accessToken and let every
    // caller eat a 401 before the batcher / withRecaptcha ladder force
    // a refresh — exactly the "VEO đã sẵn sàng nhưng bấm tạo vẫn 401"
    // symptom the user saw.
    if (parsed.updatedAt) {
      const age = Date.now() - new Date(parsed.updatedAt).getTime();
      if (Number.isFinite(age) && age > VEO_AUTH_CACHE_TTL_MS) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCachedVeoAuth(auth: VeoAuth) {
  ensureDirs();
  writeFileSync(TOKENS_CACHE_FILE, JSON.stringify(auth, null, 2), "utf-8");
}

function extractRecaptchaToken(body: string): string | null {
  const marker = '["rresp","';
  const start = body.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  const end = body.indexOf('"', from);
  if (end < 0) return null;
  return body.slice(from, end);
}

/**
 * Await `previous` but bail out early if either
 *   a) `shouldCancel()` flips to true (poll every 200ms), or
 *   b) the wall-clock exceeds `maxWaitMs`.
 *
 * The underlying `previous` promise is allowed to keep running — we
 * merely stop *waiting* on it so our caller can proceed / cancel. A
 * stuck capture ahead of us never gets to pin a fresh caller.
 */
async function waitForLock(
  previous: Promise<unknown>,
  shouldCancel: ShouldCancel | undefined,
  maxWaitMs: number,
): Promise<void> {
  if (shouldCancel?.()) throw new JobCancelledError();
  if (!shouldCancel && !Number.isFinite(maxWaitMs)) {
    await previous.catch(() => undefined);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (wallclock) clearTimeout(wallclock);
      if (err) reject(err);
      else resolve();
    };
    const wallclock = setTimeout(() => {
      done(); // timed out → proceed anyway, don't block forever
    }, maxWaitMs);
    const poll = shouldCancel
      ? setInterval(() => {
          if (shouldCancel()) done(new JobCancelledError());
        }, 200)
      : null;
    previous.then(
      () => done(),
      () => done(), // ignore previous errors; we only care about timing
    );
  });
}

function isRecaptchaReload(url: string): boolean {
  return url.includes("/recaptcha/enterprise/reload") && url.includes(RECAPTCHA_SITE_KEY);
}

/**
 * Walk an arbitrary JSON-like value looking for any string property whose key
 * looks like "sessionId" / "session_id" / "sid" and whose value looks like a
 * usable session token (non-empty, not an obvious noise value). Returns the
 * first hit, which is enough for our purposes because Flow stamps the same
 * sessionId on every event in a given batch.
 *
 * We intentionally don't match on structure (e.g. `appEvents[].eventMetadata`)
 * because that shape has drifted across Flow releases — this scan continues
 * to work as long as the field name is stable.
 */
function findSessionIdDeep(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSessionIdDeep(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase();
    const isSessionKey =
      lower === "sessionid" ||
      lower === "session_id" ||
      lower === "session-id" ||
      (lower === "sid" && typeof v === "string");
    if (isSessionKey && typeof v === "string" && v.length >= 8) {
      return v;
    }
  }
  for (const v of Object.values(obj)) {
    const hit = findSessionIdDeep(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

interface CaptureState {
  sessionId?: string;
  projectId?: string;
  accessToken?: string;
  cookie?: string;
}

/**
 * Connects via CDP to Chrome VEO, opens Flow if not already, and listens for requests/responses.
 * Returns auth info once complete + (optionally) a single recaptcha token.
 *
 * If the cache already has sessionId/projectId/accessToken, no waiting is needed — just refresh recaptcha.
 */
export class VeoTokenCollector {
  private playwright: typeof import("playwright") | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private captureState: CaptureState = {};

  /**
   * Lightweight liveness check — singleton callers use this to decide whether
   * the cached instance can still serve a request or needs to be thrown away
   * and re-initialised. The CDP connection drops when the user closes the
   * Chrome window (or when Chrome crashes / the user logs out of the OS).
   */
  isAlive(): boolean {
    try {
      return !!(this.browser && this.browser.isConnected() && this.context);
    } catch {
      return false;
    }
  }

  async init() {
    const handle = await openVeoChrome();
    const { chromium } = await import("playwright");
    this.playwright = { chromium } as unknown as typeof import("playwright");
    this.browser = await chromium.connectOverCDP(`http://${VEO_CDP_HOST}:${handle.port}`);

    // Auto-invalidate the singleton when the browser disconnects. Next call
    // to getVeoCollector() will spin up a fresh collector + reclaim tabs.
    this.browser.on("disconnected", () => {
      console.warn("[VEO] Browser disconnected — invalidating singleton");
      sessionTelemetry.record({
        target: "veo",
        kind: "reset_collector",
        detail: "browser disconnected",
      });
      const store = getStore();
      if (store.instance === this) {
        store.instance = null;
        store.initPromise = null;
      }
      this._pages = {};
      this._routeBlockedPages = new Set();
      this._pageInitPromises = {};
    });

    const contexts = this.browser.contexts();
    this.context = contexts[0] || (await this.browser.newContext());

    // Inject anti-detection / stealth script at the CONTEXT level. `addInitScript`
    // runs before any page script in every frame of every page opened (or already
    // open) in this context — so both the auth page and the per-mode tabs get it
    // automatically without having to re-inject on each `_getPageForMode`.
    //
    // Set VEO_STEALTH_DISABLED=1 to skip injection when debugging suspected
    // stealth-related breakage (e.g. spoofed WebGL tripping a WebGL-based check).
    if (process.env.VEO_STEALTH_DISABLED !== "1") {
      try {
        await this.context.addInitScript(STEALTH_SCRIPT);
        console.log("[VEO stealth] addInitScript registered on context");
      } catch (err) {
        console.warn("[VEO stealth] Failed to register init script:", err);
      }
    } else {
      console.log("[VEO stealth] Disabled via VEO_STEALTH_DISABLED=1");
    }

    // Reclaim any tabs left behind by a previous session (Next.js HMR / server
    // restart). Without this, every dev reload spawned two fresh image+video
    // tabs on top of the ones already open → the user watched Chrome fill up
    // with identical Flow tabs.
    const existing = this.context.pages();
    const claimed: Page[] = [];
    for (const p of existing) {
      const url = (p.url() || "").toLowerCase();
      if (!url.includes("labs.google/fx") && !url.startsWith("about:") && !url.startsWith("chrome://")) {
        continue;
      }
      const mode = await this._detectCurrentMode(p, 600).catch(() => null);
      if (mode && !this._pages[mode]) {
        this._pages[mode] = p;
        claimed.push(p);
        console.log(`[VEO] Reclaimed existing tab as mode=${mode}: ${p.url()}`);
      }
    }

    // The "auth" page is the one we read access_token / session from. Prefer a
    // page already on Flow that we didn't claim for a mode; otherwise fall
    // back to pages[0], or open a fresh tab if the context is empty.
    const authCandidate = existing.find(
      (p) => !claimed.includes(p) && (p.url() || "").toLowerCase().includes("labs.google/fx"),
    );
    this.page = authCandidate || existing[0] || (await this.context.newPage());

    // Force the window onto the primary screen (prevent Chrome from remembering an off-screen position)
    try {
      const cdp = await this.context.newCDPSession(this.page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 40, top: 40, width: 1280, height: 860, windowState: "normal" },
      });
      await cdp.detach();
    } catch {
      // ignore — Browser.getWindowForTarget may fail on headless, not critical
    }

    // Context-level route blocking: block every generation request from ANY page
    // in the context (like Python's `context.route("**/*", handler)`). This is a global
    // safety net — even the main page (used for auth capture) cannot fire a generation.
    try {
      const blockKeywords = VeoTokenCollector.GENERATE_BLOCK_KEYWORDS;
      await this.context.route("**/*", async (route) => {
        const url = route.request().url();
        if (blockKeywords.some((k) => url.includes(k))) {
          console.log(`[VEO] Context-level blocked: ${url.slice(0, 120)}`);
          try {
            await route.fulfill({
              status: 403,
              contentType: "application/json",
              body: JSON.stringify({ error: { code: 403, message: "blocked-by-tool-context" } }),
            });
          } catch {
            try { await route.abort(); } catch { /* ignore */ }
          }
        } else {
          try { await route.continue(); } catch { /* ignore */ }
        }
      });
      console.log(`[VEO] Context-level route blocking applied`);
    } catch (err) {
      console.warn(`[VEO] Context-level route blocking failed:`, err);
    }

    this.page.on("request", (req) => {
      const url = req.url();

      if (url.includes("https://labs.google/fx/") && !this.captureState.cookie) {
        const cookieHeader = req.headers()["cookie"];
        if (cookieHeader) this.captureState.cookie = cookieHeader;
      }

      if (
        url.includes("https://labs.google/fx/api/trpc/general.submitBatchLog") &&
        !this.captureState.sessionId
      ) {
        // Accept sessionId from ANY field anywhere in the payload. Flow has
        // changed the event schema before (the Python port only looked at
        // `eventMetadata.sessionId` inside `appEvents` for a specific event
        // name), and users who opened existing projects never hit that narrow
        // path. A recursive scan is resilient to every schema we've observed.
        try {
          const body = req.postDataJSON();
          const sid = findSessionIdDeep(body);
          if (sid) {
            this.captureState.sessionId = sid;
            console.log(`[VEO] captured sessionId from submitBatchLog (deep scan)`);
          } else {
            console.log("[VEO] submitBatchLog seen but no sessionId in payload (schema drift?)");
          }
        } catch {
          // ignore
        }
      }

      if (
        url.includes("https://labs.google/fx/api/trpc/project.createProject") &&
        !this.captureState.projectId
      ) {
        try {
          const data = req.postDataJSON() as {
            result?: { data?: { json?: { result?: { projectId?: string } } } };
          } | null;
          const pid = data?.result?.data?.json?.result?.projectId;
          if (pid) this.captureState.projectId = pid;
        } catch {
          // ignore
        }
      }
    });

    this.page.on("response", async (resp) => {
      const url = resp.url();
      if (
        url.includes("https://labs.google/fx/api/trpc/project.createProject") &&
        !this.captureState.projectId
      ) {
        try {
          const body = (await resp.json()) as {
            result?: { data?: { json?: { result?: { projectId?: string } } } };
          };
          const pid = body?.result?.data?.json?.result?.projectId;
          if (pid) this.captureState.projectId = pid;
        } catch {
          // ignore
        }
      } else if (
        url.includes("https://labs.google/fx/_next/data") &&
        !this.captureState.accessToken
      ) {
        try {
          const body = (await resp.json()) as {
            pageProps?: { session?: { access_token?: string } };
          };
          const tok = body?.pageProps?.session?.access_token;
          if (tok) this.captureState.accessToken = tok;
        } catch {
          // ignore
        }
        if (!this.captureState.cookie) {
          const req = resp.request();
          const c = req.headers()["cookie"];
          if (c) this.captureState.cookie = c;
        }
      }
    });
  }

  getPage(): Page | null {
    return this.page;
  }

  /**
   * Ensure we're on the Flow page (or the project URL if projectId is known).
   * Navigating triggers the _next/data response → captures access_token.
   */
  async ensureOnFlow(projectId?: string): Promise<void> {
    if (!this.page) throw new Error("Page not ready");
    const targetUrl = projectId
      ? `https://labs.google/fx/vi/tools/flow/project/${projectId}`
      : VEO_FLOW_URL;
    const current = this.page.url() || "";
    if (!current.startsWith("https://labs.google/fx/")) {
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } else if (projectId && !current.includes(projectId)) {
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  /**
   * Read any tokens that can be extracted directly from the page DOM / URL, without waiting for network.
   * - projectId: from URL /project/<id>
   * - accessToken: from window.__NEXT_DATA__.props.pageProps.session.access_token (SSR payload)
   * - cookie: from document.cookie
   * - sessionId: scraped from common storage locations / window globals
   */
  async extractFromPage(): Promise<void> {
    if (!this.page) return;
    try {
      const url = this.page.url() || "";
      const m = /\/project\/([^/?#]+)/.exec(url);
      if (m && !this.captureState.projectId) this.captureState.projectId = m[1];
    } catch {
      // ignore
    }
    try {
      const data = await this.page.evaluate(() => {
        type NextData = {
          props?: { pageProps?: { session?: { access_token?: string; user?: { id?: string } } } };
        };
        const nd = (window as unknown as { __NEXT_DATA__?: NextData }).__NEXT_DATA__;

        // Scan the whole __NEXT_DATA__ tree + every storage key for anything
        // that looks like a sessionId. We can't hard-code the key name because
        // Flow has changed it between releases; a targeted lookup was the
        // reason the Python port bit-rotted in the first place.
        const scan = (val: unknown, depth = 0): string | null => {
          if (depth > 8 || val == null) return null;
          if (typeof val !== "object") return null;
          if (Array.isArray(val)) {
            for (const it of val) {
              const h = scan(it, depth + 1);
              if (h) return h;
            }
            return null;
          }
          const obj = val as Record<string, unknown>;
          for (const [k, v] of Object.entries(obj)) {
            const low = k.toLowerCase();
            const isKey =
              low === "sessionid" ||
              low === "session_id" ||
              low === "session-id" ||
              (low === "sid" && typeof v === "string");
            if (isKey && typeof v === "string" && v.length >= 8) return v;
          }
          for (const v of Object.values(obj)) {
            const h = scan(v, depth + 1);
            if (h) return h;
          }
          return null;
        };

        const sweepStorage = (store: Storage | null | undefined): string | null => {
          if (!store) return null;
          try {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (!key) continue;
              const low = key.toLowerCase();
              const raw = store.getItem(key);
              if (!raw) continue;
              // Fast path: the key itself names a sessionId.
              if (
                low.includes("sessionid") ||
                low.includes("session_id") ||
                low.includes("session-id") ||
                low === "sid"
              ) {
                if (raw.length >= 8) return raw;
              }
              // Slow path: the value is a JSON blob that *contains* sessionId.
              if (raw.startsWith("{") || raw.startsWith("[")) {
                try {
                  const parsed = JSON.parse(raw);
                  const h = scan(parsed);
                  if (h) return h;
                } catch {
                  // not JSON, skip
                }
              }
            }
          } catch {
            // cross-origin or disabled storage
          }
          return null;
        };

        let sessionId: string | null = null;
        try { sessionId = sweepStorage(window.sessionStorage); } catch { /* ignore */ }
        if (!sessionId) {
          try { sessionId = sweepStorage(window.localStorage); } catch { /* ignore */ }
        }
        if (!sessionId) {
          try { sessionId = scan(nd); } catch { /* ignore */ }
        }

        return {
          accessToken: nd?.props?.pageProps?.session?.access_token || null,
          cookie: typeof document !== "undefined" ? document.cookie || "" : "",
          sessionId,
        };
      });
      if (data?.accessToken && !this.captureState.accessToken) {
        this.captureState.accessToken = data.accessToken;
      }
      if (data?.cookie && !this.captureState.cookie) {
        this.captureState.cookie = data.cookie;
      }
      if (data?.sessionId && !this.captureState.sessionId) {
        this.captureState.sessionId = data.sessionId;
        console.log("[VEO] captured sessionId from DOM scan");
      }
    } catch {
      // ignore
    }
  }

  /**
   * Nudge the Flow UI into emitting a telemetry event that carries sessionId.
   * Flow batches analytics and only flushes them for *foreground* tabs with
   * real user interaction, so a pure synthetic dispatch isn't enough —
   * we actually bring the tab to front, move the mouse, wheel-scroll a
   * pixel, and press a no-op key. We do NOT navigate, so the user stays
   * on whichever project they opened.
   */
  private async nudgeForTelemetry(): Promise<void> {
    const page = this.page;
    if (!page) return;
    try {
      await page.bringToFront();
    } catch {
      // ignore
    }
    try {
      await page.mouse.move(120 + Math.random() * 60, 140 + Math.random() * 60);
      await page.mouse.move(200 + Math.random() * 60, 260 + Math.random() * 60, { steps: 3 });
    } catch {
      // ignore
    }
    try {
      await page.mouse.wheel(0, 40);
      await page.mouse.wheel(0, -40);
    } catch {
      // ignore
    }
    try {
      // Shift is a safe no-op for the app but still registers as user input.
      await page.keyboard.press("Shift");
    } catch {
      // ignore
    }
    try {
      await page.evaluate(() => {
        try {
          window.dispatchEvent(new Event("focus"));
          document.dispatchEvent(new Event("visibilitychange"));
          // Some analytics wait for a user-gesture flag — synthesize one.
          window.dispatchEvent(new Event("pointerdown"));
          window.dispatchEvent(new Event("pointerup"));
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }

  /**
   * Wait until captureState has sessionId/projectId/accessToken.
   * If the cache already has them → use cache immediately.
   */
  async collectAuth(opts?: { timeoutMs?: number; force?: boolean }): Promise<VeoAuth> {
    const { timeoutMs = 60_000, force = false } = opts || {};

    if (!force) {
      const cached = loadCachedVeoAuth();
      if (cached) {
        sessionTelemetry.record({ target: "veo", kind: "cache_hit" });
        this.captureState = {
          sessionId: cached.sessionId,
          projectId: cached.projectId,
          accessToken: cached.accessToken,
          cookie: cached.cookie,
        };
        await this.ensureOnFlow(cached.projectId);
        return cached;
      }
      // Cache miss here usually means the TTL tripped inside
      // loadCachedVeoAuth — record it so the debug endpoint shows that the
      // silent refresh happened here and not at a 401 downstream.
      sessionTelemetry.record({ target: "veo", kind: "cache_stale" });
    }

    // Only navigate to the Flow homepage if we aren't already on a Flow page.
    // If the user is inside a project (URL: .../flow/project/<id>), leave them
    // there — that page has everything we need and kicking them out would
    // create the "verify → bounce to /flow → user re-clicks project → verify
    // → bounce again" loop we previously had.
    const currentUrl = this.page?.url() || "";
    if (!currentUrl.includes("labs.google/fx/")) {
      await this.ensureOnFlow();
    }

    // Read directly from the page (no need to wait for a new request)
    await this.extractFromPage();

    // Reload whenever something is still missing — including on a project
    // page. The URL stays the same (same project), but a reload guarantees a
    // fresh batch of _next/data + submitBatchLog requests, which our listener
    // (attached in init()) can now observe. Without this, a user who opened
    // the project tab BEFORE we attached listeners would have all telemetry
    // already fired and the listener would sit idle forever.
    const missingAfterDom =
      !this.captureState.sessionId || !this.captureState.projectId || !this.captureState.accessToken;
    if (missingAfterDom) {
      try {
        await this.page?.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      } catch {
        // ignore
      }
      await this.extractFromPage();
    }

    const deadline = Date.now() + timeoutMs;
    let lastNudge = 0;
    let reloadAttempted = false;
    while (Date.now() < deadline) {
      const s = this.captureState;
      if (s.sessionId && s.projectId && s.accessToken) {
        const auth: VeoAuth = {
          sessionId: s.sessionId,
          projectId: s.projectId,
          accessToken: s.accessToken,
          cookie: s.cookie || "",
          updatedAt: new Date().toISOString(),
        };
        saveCachedVeoAuth(auth);
        return auth;
      }

      await this.extractFromPage();

      if (Date.now() - lastNudge > 3_000) {
        lastNudge = Date.now();
        await this.nudgeForTelemetry();
      }

      // Last-ditch recovery: around 40% of the budget, if sessionId is the
      // only thing still missing AND we haven't reloaded yet inside this
      // loop, reload the *current* page (no goto → URL preserved) to force
      // a fresh submitBatchLog batch. This is safe on a project page: the
      // reload keeps the user exactly where they were.
      if (
        !reloadAttempted &&
        !this.captureState.sessionId &&
        Date.now() - (deadline - timeoutMs) > timeoutMs * 0.4
      ) {
        reloadAttempted = true;
        try {
          await this.page?.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
          await this.extractFromPage();
        } catch {
          // ignore
        }
      }

      await new Promise((r) => setTimeout(r, 700));
    }

    const missing: string[] = [];
    if (!this.captureState.sessionId) missing.push("sessionId");
    if (!this.captureState.projectId) missing.push("projectId");
    if (!this.captureState.accessToken) missing.push("access_token");
    throw new Error(
      `Không bắt được VEO auth sau ${timeoutMs}ms (thiếu: ${missing.join(", ")}). ` +
        `Hãy mở cửa sổ Chrome VEO, đảm bảo đã login, ở trong 1 project bất kỳ ` +
        `(labs.google/fx/vi/tools/flow/project/<id>) và thử di chuột/click quanh ` +
        `UI để kích hoạt telemetry, rồi bấm Verify Now.`
    );
  }

  /**
   * Per-mode pages: each mode (image/video) uses its own Playwright tab, locked
   * to that mode at init time. Completely avoids runtime mode switching (the main
   * cause of UNUSUAL_ACTIVITY when running image+video in parallel).
   */
  private _pages: { image?: Page; video?: Page } = {};
  private _routeBlockedPages: Set<Page> = new Set();
  private _pageInitPromises: { image?: Promise<Page>; video?: Promise<Page> } = {};
  /**
   * Global lock: Google reCAPTCHA Enterprise flags UNUSUAL_ACTIVITY if multiple
   * recaptcha requests run concurrently from the same account (even on different tabs).
   * So ALL recaptcha captures must be serialized through a single lane.
   */
  private _recaptchaLock: Promise<unknown> = Promise.resolve();

  /**
   * No-op placeholder: we currently don't cache recaptcha tokens (every API call needs a fresh
   * token for its specific action). API kept so the provider layer can call it on retry.
   */
  invalidateRecaptchaCache(): void {
    // intentionally empty
  }

  /**
   * Delete the cache file + captureState to force re-collecting auth next time.
   * Call this on 401 UNAUTHENTICATED from the VEO API — it means access_token has expired.
   * After calling, `collectAuth({ force: true })` will reload the page and capture a fresh token.
   */
  invalidateAuth(): void {
    sessionTelemetry.record({ target: "veo", kind: "invalidate" });
    try {
      const { unlinkSync } = require("node:fs") as typeof import("node:fs");
      if (existsSync(TOKENS_CACHE_FILE)) unlinkSync(TOKENS_CACHE_FILE);
    } catch {
      // ignore
    }
    this.captureState = {};
  }
  private static readonly GENERATE_BLOCK_KEYWORDS = [
    "batchGenerateImages",
    "batchAsyncGenerateVideoText",
    "batchAsyncGenerateVideoStartImage",
    "batchAsyncGenerateVideoStartEndImages",
  ];

  /**
   * Block the Flow UI from actually sending generation requests when we trigger the "Tạo"
   * button to grab a reCAPTCHA token. Uses **2 layers** like the original Python tool:
   *
   * 1. CDP `Network.setBlockedURLs` — blocks at the Chrome network stack level,
   *    the most reliable (request is aborted before leaving the browser).
   * 2. Playwright `page.route()` — backup layer, intercepts and returns 403.
   */
  async ensureRouteBlocking(page: Page): Promise<void> {
    if (this._routeBlockedPages.has(page)) return;
    const keywords = VeoTokenCollector.GENERATE_BLOCK_KEYWORDS;

    // Capture mode: set `VEO_CAPTURE_PAYLOADS=1` to log the full request body
    // of every blocked generation call. Useful when Google's proto schema
    // changes — press "Tạo" in labs.google UI with reference images and we'll
    // see the exact payload they send. When enabled we also disable the CDP
    // network block so the request reaches Playwright's route handler (CDP
    // would abort it earlier, hiding the post body).
    const capturePayloads = process.env.VEO_CAPTURE_PAYLOADS === "1";

    // Layer 1: CDP Network.setBlockedURLs (primary — most reliable)
    if (!capturePayloads) {
      try {
        const cdp = await this.context!.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.setBlockedURLs", {
          urls: keywords.map((k) => `*${k}*`),
        });
        console.log(`[VEO] CDP Network.setBlockedURLs applied (${keywords.length} patterns)`);
      } catch (err) {
        console.warn(`[VEO] CDP block failed, relying on Playwright route only:`, err);
      }
    } else {
      console.log("[VEO] CAPTURE MODE ON — CDP block disabled, bodies will be logged");
    }

    // Layer 2: Playwright page.route (backup + capture)
    await page.route(
      (url) => keywords.some((k) => url.toString().includes(k)),
      async (route) => {
        try {
          const req = route.request();
          const url = req.url();
          const keyword = keywords.find((k) => url.includes(k)) || "unknown";
          if (capturePayloads) {
            const body = req.postData() || "";
            // Pretty-print in chunks so long payloads are still readable in
            // the terminal. Sensitive tokens are left intact — user is in
            // control when setting VEO_CAPTURE_PAYLOADS.
            console.log(`\n========== [VEO CAPTURE] ${keyword} ==========`);
            console.log(`URL: ${url}`);
            console.log(`Body (${body.length} chars):`);
            for (let i = 0; i < body.length; i += 2000) {
              console.log(body.slice(i, i + 2000));
            }
            console.log("========== [VEO CAPTURE END] ==========\n");
          } else {
            console.log(`[VEO] Route blocked: ${url.slice(0, 120)}`);
          }
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: 403, message: "blocked-by-tool" } }),
          });
        } catch {
          // ignore
        }
      }
    );
    this._routeBlockedPages.add(page);
  }

  /**
   * Get (or lazy-init) the dedicated tab for `mode`. The tab is mode-locked
   * exactly once to avoid any runtime UI mode switching.
   *
   * Before opening a new tab, we re-scan the Chrome context for any live
   * tab whose UI already sits on the requested mode (e.g. left over from a
   * previous dev session). Reusing it saves a full tab boot (goto + 3.5s
   * settle + route-block install + model selection) and keeps Chrome from
   * filling up with duplicate Flow tabs every time Next restarts.
   */
  private async _getPageForMode(mode: "video" | "image"): Promise<Page> {
    // Re-validate the cached page before handing it back. The previous
    // implementation only checked `isClosed()` — a tab the user navigated
    // away from (e.g. clicked a link, opened DevTools "Open in new tab",
    // or the OAuth cookie expired and Flow redirected to accounts.google)
    // would still be reused and then immediately throw "page.route: Target
    // page, context or browser has been closed" or recapture-timeout when
    // the next request landed on it. By demanding a `labs.google/fx` URL
    // we force a fresh tab boot in those cases instead.
    const cached = this._pages[mode];
    if (cached) {
      const cachedUrl = (() => {
        try {
          return (cached.url() || "").toLowerCase();
        } catch {
          return "";
        }
      })();
      const usable =
        !cached.isClosed() && cachedUrl.includes("labs.google/fx");
      if (usable) return cached;
      this._pages[mode] = undefined;
    }
    if (this._pageInitPromises[mode]) return this._pageInitPromises[mode]!;
    if (!this.context) throw new Error("Context not ready");

    const init = (async (): Promise<Page> => {
      // Pass 1: scan existing context tabs for one already in the target mode.
      let page: Page | null = null;
      for (const p of this.context!.pages()) {
        if (p.isClosed()) continue;
        if (p === this.page) continue; // leave the auth page alone
        if (Object.values(this._pages).includes(p)) continue;
        const url = (p.url() || "").toLowerCase();
        if (!url.includes("labs.google/fx")) continue;
        const detected = await this._detectCurrentMode(p, 800).catch(() => null);
        if (detected === mode) {
          console.log(`[VEO] Reusing existing tab for mode=${mode}: ${p.url()}`);
          page = p;
          break;
        }
      }

      // Pass 2: no exact match — fall back to opening a new tab as before.
      if (!page) {
        page = await this.context!.newPage();
        console.log(`[VEO] Opened new tab for mode=${mode}`);
      }

      const projectId = this.captureState.projectId;
      const targetUrl = projectId
        ? `https://labs.google/fx/vi/tools/flow/project/${projectId}`
        : VEO_FLOW_URL;
      try {
        // Only navigate if the tab isn't already on a Flow page (reused tab
        // usually is, so we avoid a needless reload that would drop cached UI).
        const current = (page.url() || "").toLowerCase();
        const onFlow = current.includes("labs.google/fx");
        if (!onFlow) {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForTimeout(3500);
        }
      } catch {
        // ignore
      }
      await this.ensureRouteBlocking(page);

      // Wait for grecaptcha.enterprise.execute to be ready (the reCAPTCHA script needs time to load).
      // This is a prerequisite for the primary path in _captureRecaptchaOnce.
      try {
        await page.waitForFunction(
          () => typeof (window as unknown as { grecaptcha?: { enterprise?: { execute?: unknown } } }).grecaptcha?.enterprise?.execute === "function",
          { timeout: 10_000 }
        );
        console.log(`[VEO] grecaptcha.enterprise.execute ready (mode=${mode})`);
      } catch {
        console.warn(`[VEO] grecaptcha.enterprise.execute NOT ready after 10s (mode=${mode}) — will use fallback`);
      }

      const before = await this._detectCurrentMode(page, 2000);
      console.log(`[VEO] init page for mode=${mode}, detected=${before}`);
      if (before !== mode) {
        const ok = await this._ensureMode(page, mode).catch(() => false);
        const after = await this._detectCurrentMode(page, 1500);
        console.log(`[VEO] mode switch ok=${ok}, final=${after}`);
      }

      // Select the Lower Priority model (0 credits) in the Flow UI for the video page.
      // If blocking fails and the Flow UI actually creates the "a" video, it will use the free model.
      if (mode === "video") {
        await this._selectLowerPriorityModel(page);
      }

      this._pages[mode] = page;
      return page;
    })();
    this._pageInitPromises[mode] = init;
    try {
      return await init;
    } finally {
      this._pageInitPromises[mode] = undefined;
    }
  }

  /**
   * Public wrapper around the internal `_getPageForMode` so the provider
   * layer (withRecaptcha, batcher) can grab the SAME tab that minted the
   * reCAPTCHA token and route the API POST through its browser context.
   *
   * This is the core of the "Option 2" fingerprint-binding fix: the
   * request.post goes out with the tab's UA, Sec-CH-UA, Origin, Referer
   * and cookie jar, matching what grecaptcha.enterprise.execute saw.
   */
  async getPageForMode(mode: "video" | "image"): Promise<Page> {
    return this._getPageForMode(mode);
  }

  /**
   * Drop the cached page handle for `mode` without touching auth or the
   * rest of the Chrome session. Called by the provider layer when a
   * request throws a transient page-level error (e.g. "Target closed",
   * "socket hang up", status=0) — the tab may still be alive in Chrome
   * but the Playwright handle is no longer usable, so we want the next
   * `getPageForMode(mode)` call to re-scan and attach to a fresh tab.
   *
   * Cheaper than `restartBrowser()` and preserves OAuth cache.
   */
  invalidatePageForMode(mode: "video" | "image"): void {
    const p = this._pages[mode];
    if (p && !p.isClosed()) {
      // Don't try to close — the error that triggered this may have
      // already killed the underlying target, and .close() would throw.
      console.warn(`[VEO] invalidatePageForMode(${mode}): dropping stale handle`);
    }
    this._pages[mode] = undefined;
    this._pageInitPromises[mode] = undefined;
  }

  /**
   * Wipe every cached bit of the current origin (localStorage, IndexedDB,
   * service workers, trust tokens, HTTP cache) and reload the tab. Called
   * as step 2 of the 403-recovery ladder: when retrying with a fresh
   * recaptcha token isn't enough, Google is usually remembering something
   * it dislikes (device token, abuse cookie, stale session cookie). A
   * clean slate + reload forces the UI to re-bootstrap from scratch, after
   * which the next recaptcha token is almost always accepted.
   *
   * Port of `_clear_site_storage` in A_workflow_get_token.py (lines
   * 1029-1071). We also flush `_pages[mode]` mode-ready caches so the
   * next request re-runs `_ensureMode` / `_selectLowerPriorityModel`.
   */
  async clearSiteStorage(mode: "video" | "image"): Promise<void> {
    if (!this.context) return;
    const page = this._pages[mode];
    if (!page || page.isClosed()) {
      console.warn(`[VEO] clearSiteStorage: no live tab for mode=${mode}, skipping`);
      return;
    }
    const currentUrl = page.url() || "";
    let origin: string | null = null;
    try {
      const parsed = new URL(currentUrl);
      if (parsed.protocol && parsed.host) {
        origin = `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      // ignore malformed URL
    }
    if (!origin) {
      console.warn(`[VEO] clearSiteStorage: cannot derive origin from "${currentUrl}"`);
      return;
    }
    try {
      console.log(`[VEO] Clear site storage for ${origin} (mode=${mode})`);
      const cdp = await this.context.newCDPSession(page);
      await cdp.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: [
          "local_storage",
          "session_storage",
          "indexeddb",
          "cache_storage",
          "service_workers",
          "websql",
          "file_systems",
          "shared_storage",
          "cookies",
        ].join(","),
      });
      try {
        await cdp.send("Storage.clearTrustTokens");
      } catch {
        // older Chromes reject this method — not fatal
      }
      try {
        await cdp.send("Network.clearBrowserCache");
      } catch {
        // ignore
      }
      try {
        await cdp.detach();
      } catch {
        // ignore
      }
      console.log(`[VEO] Reload tab after clear storage (mode=${mode})`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      // After a reload the Flow UI comes up on whatever mode was last
      // selected — drop the per-tab "mode-ready" marker so the next
      // recaptcha capture re-verifies the mode and re-applies route
      // blocking (the page.route handlers survive the reload but the
      // CDP-level Network.setBlockedURLs needs to be re-armed).
      this._routeBlockedPages.delete(page);
    } catch (err) {
      console.warn("[VEO] clearSiteStorage failed:", err);
    }
  }

  /**
   * Hard restart of the whole Chrome session: close the current CDP
   * connection, relaunch Chrome via `openVeoChrome()`, then re-init the
   * collector. Used as the last step of the 403-recovery ladder (after
   * retry + clearStorage have failed). This is the only move that
   * recycles the TLS client hello + HTTP/2 connection pool, which is
   * what Google ultimately keys abuse signals on.
   *
   * Port of `restart_browser` in A_workflow_get_token.py (lines 929-962).
   *
   * After this returns, callers must re-acquire `getPageForMode(mode)` —
   * the old Page objects are dead and the _pages map is cleared.
   */
  async restartBrowser(): Promise<void> {
    console.warn("[VEO] restartBrowser: closing old Chrome connection and reopening");
    try {
      await this.browser?.close();
    } catch {
      // ignore — the browser might already be gone
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this._pages = {};
    this._routeBlockedPages = new Set();
    this._pageInitPromises = {};
    this.captureState = {};

    // Re-connect via the same CDP manager — openVeoChrome will relaunch
    // the Chrome executable if the process already died, or reuse it if
    // it's still running on the debug port.
    await this.init();

    // Re-hydrate auth from cache if still valid so we don't block on a
    // fresh login flow; collectAuth with force=false is the cheap path.
    try {
      await this.collectAuth({ force: false, timeoutMs: 30_000 });
    } catch (err) {
      console.warn("[VEO] restartBrowser: post-restart collectAuth failed:", err);
    }
    console.log("[VEO] restartBrowser: ready");
  }

  /**
   * Detect the current mode from the aria-haspopup='menu' dropdown button:
   *  - "video": button contains "Video"
   *  - "image": button contains "Nano Banana" or "Imagen"
   * Faithful port of Python `_detect_current_mode`.
   */
  private async _detectCurrentMode(page: Page, timeoutMs = 1800): Promise<"video" | "image" | null> {
    const perTry = Math.max(400, Math.floor(timeoutMs / 2));
    const cfg: Array<{ mode: "video" | "image"; xpath: string }> = [
      {
        mode: "video",
        xpath: "//button[@aria-haspopup='menu' and contains(normalize-space(.), 'Video')]",
      },
      {
        mode: "image",
        xpath:
          "//button[@aria-haspopup='menu' and (contains(normalize-space(.), 'Nano Banana') or contains(normalize-space(.), 'Imagen'))]",
      },
    ];
    for (const { mode, xpath } of cfg) {
      try {
        const loc = page.locator(`xpath=${xpath}`).first();
        await loc.waitFor({ state: "visible", timeout: perTry });
        return mode;
      } catch {
        // try next
      }
    }
    return null;
  }

  /**
   * Switch the Flow UI to the target mode:
   *  1. Detect the current mode
   *  2. If already correct → return
   *  3. Click the mode indicator to open the menu
   *  4. Click the matching tab (role='tab' + text 'Video'/'Image')
   *  5. Verify + close the menu (click the indicator again if needed)
   * Port of Python `_switch_to_mode`.
   */
  private async _ensureMode(page: Page, target: "video" | "image"): Promise<boolean> {
    const current = await this._detectCurrentMode(page, 1500);
    if (current === target) return true;

    const openerXpath =
      current === "image"
        ? "//button[@aria-haspopup='menu' and (contains(normalize-space(.), 'Nano Banana') or contains(normalize-space(.), 'Imagen'))]"
        : "//button[@aria-haspopup='menu' and contains(normalize-space(.), 'Video')]";

    // The UI may be Vietnamese or English → match both labels.
    const tabXpath =
      target === "video"
        ? "//button[@role='tab' and contains(normalize-space(.), 'Video')]"
        : "//button[@role='tab' and (contains(normalize-space(.), 'Image') or contains(normalize-space(.), 'Hình'))]";

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const opener = page.locator(`xpath=${openerXpath}`).first();
        if ((await opener.count()) === 0) {
          const re = await this._detectCurrentMode(page, 1000);
          if (re === target) return true;
          await page.waitForTimeout(400);
          continue;
        }
        await opener.click({ timeout: 1500, force: true });
        await page.waitForTimeout(300);

        const tab = page.locator(`xpath=${tabXpath}`).first();
        await tab.waitFor({ state: "visible", timeout: 3000 });
        await tab.click({ timeout: 1500, force: true });
        await page.waitForTimeout(1200);

        const verified = await this._detectCurrentMode(page, 2500);
        if (verified === target) {
          try {
            await page.keyboard.press("Escape");
          } catch {
            // ignore
          }
          return true;
        }
      } catch {
        // retry
      }
    }
    return false;
  }

  /**
   * Select the "Lower Priority" model (0 credits) in the Flow UI video mode.
   * Flow UI has a model dropdown (aria-haspopup='menu') → click to open → pick the item
   * containing "lower" (case-insensitive). If it fails → ignore (blocking still protects us).
   *
   * Called once when the video page is initialized. Ensures that if blocking fails, the "a"
   * video uses the free model instead of Ultra Fast (20 credits).
   */
  private async _selectLowerPriorityModel(page: Page): Promise<void> {
    try {
      // Flow UI video mode: the dropdown button contains "Video" (or the current model name)
      // with aria-haspopup='menu'. Click it to open the model menu.
      const modelDropdown = page.locator("button[aria-haspopup='menu']").first();
      if ((await modelDropdown.count()) === 0) {
        console.warn("[VEO] Model dropdown not found — skip lower priority selection");
        return;
      }
      await modelDropdown.click({ timeout: 2000, force: true });
      await page.waitForTimeout(500);

      // Find the menu item containing "lower" (matches "Lower priority" / "Lower Priority")
      const lowerItem = page.locator(
        'div[role="menuitem"]:text-matches("lower", "i"), ' +
        'button[role="menuitem"]:text-matches("lower", "i"), ' +
        'li[role="menuitem"]:text-matches("lower", "i"), ' +
        '[role="option"]:text-matches("lower", "i")'
      ).first();

      if ((await lowerItem.count()) > 0) {
        await lowerItem.click({ timeout: 2000, force: true });
        await page.waitForTimeout(300);
        console.log("[VEO] Selected Lower Priority model (0 credits) for recaptcha trigger page");
      } else {
        // Close the menu if not found
        await page.keyboard.press("Escape");
        console.warn("[VEO] 'Lower Priority' menu item not found in model dropdown");
      }
    } catch (err) {
      console.warn("[VEO] Failed to select Lower Priority model:", err);
      try { await page.keyboard.press("Escape"); } catch { /* ignore */ }
    }
  }

  /**
   * Trigger a recaptcha reload by simulating a user click on the "Tạo" button.
   * This approach is ported from the Python tool (A_workflow_get_token.py): block the generate
   * request with route.fulfill(403) but still let the UI trigger → Flow calls
   * grecaptcha.enterprise.execute() with the EXACT action → /recaptcha/enterprise/reload response contains rresp.
   */
  /**
   * Capture a fresh reCAPTCHA enterprise token from the live Flow tab.
   *
   * The first capture for a given `mode` after the collector boots
   * usually has to also pay for `_getPageForMode` opening a brand new
   * tab, navigating to `labs.google/fx`, settling for ~3.5s and waiting
   * for `grecaptcha.enterprise.execute` to load. On a slow network the
   * 25s default isn't enough to cover all of that plus the actual
   * recaptcha reload roundtrip — we observed repeated
   * `Không bắt được recaptcha token sau 25000ms` errors in
   * `logs/error.log`. Bumping the first-use deadline to 40s removes the
   * need for the caller to pay another ~15s retry delay just to land on
   * a tab that was already going to take that long anyway.
   *
   * Subsequent captures reuse the same warm tab (route block already
   * installed → tab is in `_routeBlockedPages`) so the original 25s
   * budget is plenty.
   *
   * Both signatures are kept for backwards compatibility:
   *   - `getFreshRecaptchaToken(timeoutMs, mode)` — legacy positional
   *   - `getFreshRecaptchaToken({ timeoutMs, firstUseTimeoutMs, mode })` — new opts
   */
  async getFreshRecaptchaToken(
    optsOrTimeout?:
      | number
      | {
          timeoutMs?: number;
          firstUseTimeoutMs?: number;
          mode?: "video" | "image";
          shouldCancel?: ShouldCancel;
        },
    legacyMode: "video" | "image" = "video",
    legacyShouldCancel?: ShouldCancel,
  ): Promise<string> {
    if (!this.context) throw new Error("Context not ready");

    let timeoutMs: number;
    let firstUseTimeoutMs: number;
    let mode: "video" | "image";
    let shouldCancel: ShouldCancel | undefined;
    if (typeof optsOrTimeout === "object" && optsOrTimeout != null) {
      timeoutMs = optsOrTimeout.timeoutMs ?? 25_000;
      firstUseTimeoutMs = optsOrTimeout.firstUseTimeoutMs ?? 40_000;
      mode = optsOrTimeout.mode ?? legacyMode;
      shouldCancel = optsOrTimeout.shouldCancel ?? legacyShouldCancel;
    } else {
      timeoutMs = optsOrTimeout ?? 25_000;
      firstUseTimeoutMs = Math.max(timeoutMs, 40_000);
      mode = legacyMode;
      shouldCancel = legacyShouldCancel;
    }

    // "First use" = no cached page handle for this mode, OR the cached
    // page hasn't been route-blocked yet (i.e. _getPageForMode hasn't
    // wired up the block-the-real-generate-request route handler that
    // forces grecaptcha.enterprise.execute to actually fire). Either way
    // the next capture has to pay the full goto + settle + grecaptcha
    // bootstrap cost.
    const cachedPage = this._pages[mode];
    const isFirstUse =
      !cachedPage ||
      cachedPage.isClosed() ||
      !this._routeBlockedPages.has(cachedPage);
    const effectiveTimeout = isFirstUse ? firstUseTimeoutMs : timeoutMs;

    // Global chain lock: synchronous .then() chaining. Ensures only one recaptcha capture
    // runs at any given time across the entire collector.
    //
    // We install OUR promise into `_recaptchaLock` synchronously so the
    // next caller chains behind us. But `previous` — the in-flight
    // capture we're waiting on — must NEVER block us past either
    //   a) `RECAPTCHA_LOCK_MAX_WAIT_MS` wall-clock (dead capture never
    //      hit its finally), or
    //   b) the caller's cancel flag flipping (we don't hold a capture
    //      hostage for a job that the user already gave up on).
    //
    // Without this race the lock chain accumulates indefinitely: every
    // new submit piled on top of a stuck one silently extends total
    // wait, and the user sees "RUNNING · cancelling… · 800s · 1%"
    // while the executor is pinned waiting for `previous` to resolve.
    const previous = this._recaptchaLock;
    let release: () => void = () => {};
    this._recaptchaLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForLock(previous, shouldCancel, RECAPTCHA_LOCK_MAX_WAIT_MS);
      // Final cancel check right before the expensive capture so a
      // user who hit cancel WHILE we were queued doesn't burn a 40s
      // token budget on their behalf.
      if (shouldCancel?.()) throw new JobCancelledError();
      return await this._captureRecaptchaOnce(effectiveTimeout, mode, shouldCancel);
    } finally {
      release();
    }
  }

  private async _captureRecaptchaOnce(
    timeoutMs: number,
    mode: "video" | "image",
    shouldCancel?: ShouldCancel,
  ): Promise<string> {
    if (shouldCancel?.()) throw new JobCancelledError();
    const page = await this._getPageForMode(mode);
    if (shouldCancel?.()) throw new JobCancelledError();

    // Foreground tab: Chrome throttles grecaptcha on background tabs.
    try {
      await page.bringToFront();
    } catch {
      // ignore
    }

    // Clear any leftover prompt + dismiss error dialogs before triggering.
    try {
      await this._clearPromptAndDismiss(page);
    } catch {
      // ignore
    }

    if (shouldCancel?.()) throw new JobCancelledError();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Không bắt được recaptcha token sau ${timeoutMs}ms (mode=${mode}). ` +
              `Đảm bảo đang ở project page và UI Flow load xong. ` +
              `Nếu cửa sổ Chrome VEO bị minimize / tab VEO đang là tab nền, ` +
              `Chrome sẽ throttle grecaptcha → hãy giữ cửa sổ Chrome VEO foreground khi chạy.`
          )
        );
      }, timeoutMs);

      // Cancel-poll: if the caller's cancel flag flips while we're
      // waiting for the network response, bail out within ~200ms
      // instead of burning the full capture budget. Matches the polling
      // cadence of `raceCancel` upstream so the cancel signal
      // propagates cleanly through the provider chain.
      let cancelTimer: ReturnType<typeof setInterval> | null = null;
      if (shouldCancel) {
        cancelTimer = setInterval(() => {
          if (shouldCancel?.()) {
            cleanup();
            clearTimeout(timer);
            reject(new JobCancelledError());
          }
        }, 200);
      }

      const onResponse = async (resp: { url(): string; text(): Promise<string> }) => {
        try {
          if (!isRecaptchaReload(resp.url())) return;
          const text = await resp.text();
          const tok = extractRecaptchaToken(text);
          if (tok) {
            cleanup();
            clearTimeout(timer);
            resolve(tok);
          }
        } catch {
          // ignore
        }
      };

      const cleanup = () => {
        try {
          page.off("response", onResponse);
        } catch {
          // ignore
        }
        if (cancelTimer) {
          clearInterval(cancelTimer);
          cancelTimer = null;
        }
      };

      page.on("response", onResponse);

      // PRIMARY: trigger the UI "Tạo" button → the Flow app calls grecaptcha.enterprise.execute
      // with the exact action → network response contains a valid token.
      // Route blocking (ensureRouteBlocking) blocks the actual generation request → 403.
      // FALLBACK: if the UI trigger fails (e.g. textarea not found), call execute()
      // directly — the token may be rejected but it's still better than timing out.
      void this._triggerCreateInUI(page).catch(() => {
        console.warn(`[VEO] UI trigger failed, trying direct grecaptcha.execute (mode=${mode})`);
        const siteKey = RECAPTCHA_SITE_KEY;
        void page
          .evaluate((key: string) => {
            type GEnt = { execute?: (k: string, o: { action: string }) => Promise<string> };
            type W = Window & { grecaptcha?: { enterprise?: GEnt } };
            const w = window as unknown as W;
            w.grecaptcha?.enterprise?.execute?.(key, { action: "submit" });
          }, siteKey)
          .catch(() => undefined);
      });
    });
  }

  /**
   * Dismiss error dialogs (if any) + clear the previous prompt without reloading the page.
   * Mimics the Python flow: the page stays "alive" between fetches, just needs a light UI reset.
   */
  private async _clearPromptAndDismiss(page: Page): Promise<void> {
    // Close any dialog/alert with Escape (best-effort)
    for (let i = 0; i < 3; i++) {
      try {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(80);
      } catch {
        // ignore
      }
    }
    // Click any "Close"/"Đóng"/"Bỏ qua" buttons if present (best-effort)
    const dismissSelectors = [
      'button[aria-label*="close" i]',
      'button[aria-label*="Đóng" i]',
      'button:has-text("Close")',
      'button:has-text("OK")',
    ];
    for (const sel of dismissSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
          await el.click({ timeout: 500, force: true }).catch(() => undefined);
        }
      } catch {
        // ignore
      }
    }
    // Clear the prompt so the next typing starts fresh
    const promptSelectors = [
      'textarea[placeholder*="Bạn muốn tạo"]',
      'textarea[placeholder*="muốn tạo"]',
      'textarea[placeholder*="What do you want"]',
      "textarea",
    ];
    for (const sel of promptSelectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) === 0) continue;
        await el.fill("", { timeout: 500 }).catch(() => undefined);
        break;
      } catch {
        // continue
      }
    }
  }

  private async _triggerCreateInUI(page: Page): Promise<void> {
    const promptSelectors = [
      'textarea[placeholder*="Bạn muốn tạo"]',
      'textarea[placeholder*="muốn tạo"]',
      'textarea[placeholder*="What do you want"]',
      'textarea[placeholder*="Describe"]',
      'div[contenteditable="true"][role="textbox"]',
      "textarea",
    ];
    // Wait for textarea visible (Python waits up to 60s) — the page may still be loading the Flow app
    let filled = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !filled) {
      for (const sel of promptSelectors) {
        try {
          const el = page.locator(sel).first();
          if ((await el.count()) === 0) continue;
          if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
          await el.click({ timeout: 800, force: true });
          await el.fill("a", { timeout: 1000 }).catch(async () => {
            await el.type("a", { timeout: 1000 });
          });
          filled = true;
          break;
        } catch {
          // continue
        }
      }
      if (!filled) await page.waitForTimeout(400);
    }
    if (!filled) throw new Error("Cannot find prompt input");
    await page.waitForTimeout(250);

    const btnSelectors = [
      'button:has-text("Tạo"):not(:has-text("Trình tạo cảnh")):not(:has-text("Không tạo được"))',
      'button:has-text("Generate")',
      'button:has-text("Create")',
      'button[aria-label*="prompt" i]:not([disabled])',
      'button[aria-label*="submit" i]:not([disabled])',
      'button[aria-label*="Gửi" i]:not([disabled])',
      'button[type="submit"]:not([disabled])',
      'form button:not([disabled]):has(svg)',
    ];
    for (const sel of btnSelectors) {
      try {
        const btn = page.locator(sel).last();
        if ((await btn.count()) === 0) continue;
        await btn.click({ timeout: 1000, force: true });
        return;
      } catch {
        // continue
      }
    }

    try {
      await page.keyboard.press("Enter", { delay: 50 });
    } catch {
      // ignore
    }
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Singleton pattern: keep just one instance to reuse the Chrome context.
 *
 * IMPORTANT: we stash the instance on `globalThis` so it survives Next.js
 * development-mode HMR reloads. Otherwise every code change wiped the
 * module-level var, the next VEO request built a fresh collector and it
 * opened brand-new image + video tabs on top of the old ones.
 */
type VeoSingletonStore = {
  instance: VeoTokenCollector | null;
  initPromise: Promise<VeoTokenCollector> | null;
};
const GLOBAL_KEY = "__veoTokenCollectorSingleton__";
function getStore(): VeoSingletonStore {
  const g = globalThis as unknown as Record<string, VeoSingletonStore | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { instance: null, initPromise: null };
  return g[GLOBAL_KEY]!;
}

/**
 * Drop any cached instance that can't serve the current code path. Two
 * independent failure modes are handled here:
 *
 *  1. **Dead browser** — the user closed the Chrome window while the app
 *     sat idle. `isAlive()` returns false and we must reconnect.
 *
 *  2. **Stale prototype (HMR)** — Next.js dev-mode reloaded this module
 *     after a code edit, which gives us a brand-new `VeoTokenCollector`
 *     class object (new function identity, new prototype chain). The
 *     instance still parked on `globalThis` was constructed by the OLD
 *     class, so it lacks any methods we've added since. `instanceof` is
 *     the principled way to detect this: the old instance is NOT an
 *     instance of the *current* class, even though they share a name.
 *     Trying to duck-type individual methods would only paper over each
 *     symptom until the next method gets added.
 *
 * When either check fails we close the old instance's resources (via
 * optional chaining because the old prototype may even lack `.close`)
 * and start fresh.
 */
async function dropStaleInstance(store: VeoSingletonStore): Promise<void> {
  const inst = store.instance;
  if (!inst) return;
  // DELIBERATELY no `instanceof VeoTokenCollector` check here.
  //
  // In Next.js dev mode every HMR reload creates a brand-new class
  // object with a fresh function identity, so `old instanceof New` is
  // always false for the cached instance. Previously this forced
  // `alive = false`, which then called `.close()` on the live browser
  // handle and disposed every Playwright request context held by
  // in-flight jobs. Jobs would immediately fail with
  // "apiRequestContext.post: Request context disposed", even though
  // Chrome itself was perfectly healthy.
  //
  // Methods defined on the old prototype are still callable on the
  // cached instance (JS keeps the prototype chain intact), and the
  // public API (getFreshRecaptchaToken, collectAuth, getPageForMode,
  // etc.) is backwards-compatible across revisions. If user-visible
  // behaviour needs a cold restart of the collector they can close
  // Chrome or restart the dev server — small cost for not killing
  // every running job on every code save.
  if (safeIsAlive(inst)) return;
  console.warn(`[VEO] Dropping dead collector (alive=false) — reinitialising`);
  try {
    const closer = (inst as { close?: () => Promise<void> }).close;
    if (typeof closer === "function") await closer.call(inst);
  } catch {
    // ignore: the stale instance may already be in a broken state
  }
  store.instance = null;
  store.initPromise = null;
}

function safeIsAlive(inst: unknown): boolean {
  try {
    const i = inst as { isAlive?: () => boolean };
    return typeof i?.isAlive === "function" && i.isAlive();
  } catch {
    return false;
  }
}

export async function getVeoCollector(): Promise<VeoTokenCollector> {
  const store = getStore();
  await dropStaleInstance(store);
  if (store.instance) return store.instance;
  if (store.initPromise) {
    // There's an in-flight init. Await it, then re-validate: if HMR raced
    // and the resolved value belongs to an older class, dropStaleInstance
    // will clean it up on the next pass and we'll retry.
    try {
      const pending = await store.initPromise;
      if (pending && safeIsAlive(pending)) return pending;
    } catch {
      // fall through and start fresh
    }
    await dropStaleInstance(store);
  }
  store.initPromise = (async () => {
    const inst = new VeoTokenCollector();
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
