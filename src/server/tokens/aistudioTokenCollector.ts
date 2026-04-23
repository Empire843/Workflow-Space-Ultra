/**
 * Browser session manager for the Gemini Playwright video-analysis provider.
 *
 * Connects (once) to the dedicated Chrome profile that is already logged into
 * the user's Google / Gemini Advanced account, and hands out `Page` handles
 * for UI automation on `gemini.google.com`.
 *
 * No Bearer token or API key is captured here — the Playwright provider
 * drives gemini.google.com's UI directly.  Cookies persisted in the Chrome
 * profile are what authenticate every request.
 *
 * (Kept in the tokens/ folder to avoid moving files around; the name is a
 * historical artefact from when an OAuth Bearer capture was attempted.)
 */

import type { Browser, BrowserContext, Page } from "playwright";

import { AISTUDIO_CDP_HOST } from "../config";
import { openAiStudioChrome } from "../chrome/aistudioChromeManager";

export class AiStudioBrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  isAlive(): boolean {
    try {
      return !!(this.browser && this.browser.isConnected() && this.context);
    } catch {
      return false;
    }
  }

  async init() {
    const handle = await openAiStudioChrome();
    const { chromium } = await import("playwright");
    this.browser = await chromium.connectOverCDP(
      `http://${AISTUDIO_CDP_HOST}:${handle.port}`,
    );

    this.browser.on("disconnected", () => {
      console.warn("[GeminiUI] Browser disconnected — invalidating singleton");
      const store = getStore();
      if (store.instance === this) {
        store.instance = null;
        store.initPromise = null;
      }
    });

    this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());

    // Ensure there's at least one tab and make the window visible/sized so
    // the user can watch the automation.
    const pages = this.context.pages();
    const firstPage = pages[0] ?? (await this.context.newPage());
    try {
      const cdp = await this.context.newCDPSession(firstPage);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { left: 120, top: 40, width: 1280, height: 860, windowState: "normal" },
      });
      await cdp.detach();
    } catch {
      // ignore
    }
  }

  /** Opens a fresh tab for one automation run.  Caller must close it afterward. */
  async newPage(): Promise<Page> {
    if (!this.context) {
      throw new Error("AiStudioBrowserSession chưa init");
    }
    return this.context.newPage();
  }
}

// ── Singleton ─────────────────────────────────────────────────────

interface Store {
  instance: AiStudioBrowserSession | null;
  initPromise: Promise<AiStudioBrowserSession> | null;
}

const _store: Store = { instance: null, initPromise: null };

function getStore(): Store {
  return _store;
}

export async function getAiStudioCollector(): Promise<AiStudioBrowserSession> {
  const store = getStore();
  if (store.instance?.isAlive()) return store.instance;
  if (store.initPromise) return store.initPromise;

  store.initPromise = (async () => {
    const s = new AiStudioBrowserSession();
    await s.init();
    store.instance = s;
    store.initPromise = null;
    return s;
  })();

  try {
    return await store.initPromise;
  } catch (e) {
    store.initPromise = null;
    throw e;
  }
}
