import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "playwright";

import { DATA_GENERAL_DIR, VEO_CDP_HOST, VEO_FLOW_URL, RECAPTCHA_SITE_KEY, ensureDirs } from "../config";
import { openVeoChrome } from "../chrome/veoChromeManager";

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

export function loadCachedVeoAuth(): VeoAuth | null {
  try {
    ensureDirs();
    if (!existsSync(TOKENS_CACHE_FILE)) return null;
    const raw = readFileSync(TOKENS_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as VeoAuth;
    if (parsed.sessionId && parsed.projectId && parsed.accessToken) return parsed;
    return null;
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

function isRecaptchaReload(url: string): boolean {
  return url.includes("/recaptcha/enterprise/reload") && url.includes(RECAPTCHA_SITE_KEY);
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

  async init() {
    const handle = await openVeoChrome();
    const { chromium } = await import("playwright");
    this.playwright = { chromium } as unknown as typeof import("playwright");
    this.browser = await chromium.connectOverCDP(`http://${VEO_CDP_HOST}:${handle.port}`);
    const contexts = this.browser.contexts();
    this.context = contexts[0] || (await this.browser.newContext());
    const pages = this.context.pages();
    this.page = pages[0] || (await this.context.newPage());

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
        try {
          const data = req.postDataJSON() as {
            json?: { appEvents?: Array<{ event?: string; eventMetadata?: { sessionId?: string } }> };
          } | null;
          if (data) {
            const events = data.json?.appEvents || [];
            for (const ev of events) {
              if (ev.event === "PINHOLE_CREATE_NEW_PROJECT") {
                const sid = ev.eventMetadata?.sessionId;
                if (sid) this.captureState.sessionId = sid;
              }
            }
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
        return {
          accessToken: nd?.props?.pageProps?.session?.access_token || null,
          cookie: typeof document !== "undefined" ? document.cookie || "" : "",
        };
      });
      if (data?.accessToken && !this.captureState.accessToken) {
        this.captureState.accessToken = data.accessToken;
      }
      if (data?.cookie && !this.captureState.cookie) {
        this.captureState.cookie = data.cookie;
      }
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
        this.captureState = {
          sessionId: cached.sessionId,
          projectId: cached.projectId,
          accessToken: cached.accessToken,
          cookie: cached.cookie,
        };
        await this.ensureOnFlow(cached.projectId);
        return cached;
      }
    }

    await this.ensureOnFlow();

    // Read directly from the page (no need to wait for a new request)
    await this.extractFromPage();

    // If something is still missing, reload to re-trigger _next/data + other requests
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
    let triedCreateProject = false;
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

      // sessionId still missing → need to trigger submitBatchLog event PINHOLE_CREATE_NEW_PROJECT.
      // That event fires when the "new project" button is clicked. Wait for the first half of the budget,
      // then try navigating to the Flow homepage (which on some sessions triggers creating a default project).
      if (!triedCreateProject && Date.now() - (deadline - timeoutMs) > timeoutMs * 0.4) {
        triedCreateProject = true;
        try {
          // Re-extract from DOM once more (access_token may now be present from _next/data)
          await this.extractFromPage();
          // Navigate back to root so we can trigger the create-project flow
          await this.page?.goto(VEO_FLOW_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
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
        `Hãy vào cửa sổ Chrome VEO, login xong thì BẤM NÚT 'New Project' hoặc mở/tạo 1 project bất kỳ trong Flow, ` +
        `rồi quay lại bấm Test VEO session.`
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

    // Layer 1: CDP Network.setBlockedURLs (primary — most reliable)
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

    // Layer 2: Playwright page.route (backup)
    await page.route(
      (url) => keywords.some((k) => url.toString().includes(k)),
      async (route) => {
        try {
          console.log(`[VEO] Route blocked: ${route.request().url().slice(0, 120)}`);
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
   */
  private async _getPageForMode(mode: "video" | "image"): Promise<Page> {
    if (this._pages[mode]) return this._pages[mode]!;
    if (this._pageInitPromises[mode]) return this._pageInitPromises[mode]!;
    if (!this.context) throw new Error("Context not ready");

    const init = (async (): Promise<Page> => {
      const page = await this.context!.newPage();
      const projectId = this.captureState.projectId;
      const targetUrl = projectId
        ? `https://labs.google/fx/vi/tools/flow/project/${projectId}`
        : VEO_FLOW_URL;
      try {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(3500);
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
  async getFreshRecaptchaToken(timeoutMs = 25_000, mode: "video" | "image" = "video"): Promise<string> {
    if (!this.context) throw new Error("Context not ready");

    // Global chain lock: synchronous .then() chaining. Ensures only one recaptcha capture
    // runs at any given time across the entire collector.
    const previous = this._recaptchaLock;
    let release: () => void = () => {};
    this._recaptchaLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous.catch(() => undefined);
      return await this._captureRecaptchaOnce(timeoutMs, mode);
    } finally {
      release();
    }
  }

  private async _captureRecaptchaOnce(timeoutMs: number, mode: "video" | "image"): Promise<string> {
    const page = await this._getPageForMode(mode);

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

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Không bắt được recaptcha token sau ${timeoutMs}ms (mode=${mode}). ` +
              `Đảm bảo đang ở project page và UI Flow load xong.`
          )
        );
      }, timeoutMs);

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
 */
let _singleton: VeoTokenCollector | null = null;
let _initPromise: Promise<VeoTokenCollector> | null = null;

export async function getVeoCollector(): Promise<VeoTokenCollector> {
  if (_singleton) return _singleton;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const inst = new VeoTokenCollector();
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
