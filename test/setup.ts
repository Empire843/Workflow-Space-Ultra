/**
 * Global Vitest setup: resets Zustand stores between tests and installs a minimal
 * EventSource polyfill that can be driven by the fake job server helper.
 */

import os from "node:os";
import path from "node:path";

import { afterEach, vi } from "vitest";

// Point the OAuth file store at a tmpdir so tests never touch the real
// `data_general/oauth/` folder. Modules read `WSU_OAUTH_DIR` via the
// `oauthDir()` getter, so setting this at setup time is enough.
if (!process.env.WSU_OAUTH_DIR) {
  process.env.WSU_OAUTH_DIR = path.join(os.tmpdir(), `wsu-oauth-test-${process.pid}`);
}

declare global {
  interface Window {
    __fakeJobEmitters?: Map<string, (ev: MessageEvent) => void>;
  }
}

{
  class FakeEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;

    readyState = FakeEventSource.CONNECTING;
    url: string;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    onopen: ((ev: Event) => void) | null = null;

    constructor(url: string) {
      this.url = url;
      this.readyState = FakeEventSource.OPEN;
      const id = url.replace(/^.*\/jobs\/([^/]+)\/stream.*$/, "$1");
      if (!globalThis.window) {
        (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
      }
      if (!window.__fakeJobEmitters) window.__fakeJobEmitters = new Map();
      window.__fakeJobEmitters.set(id, (ev) => {
        this.onmessage?.(ev);
      });
      queueMicrotask(() => this.onopen?.(new Event("open")));
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }

  (globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource =
    FakeEventSource;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (typeof window !== "undefined" && window.__fakeJobEmitters) {
    window.__fakeJobEmitters.clear();
  }
});
