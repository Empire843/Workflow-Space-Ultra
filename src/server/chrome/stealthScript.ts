/**
 * Stealth init script injected into every Playwright page via
 * `context.addInitScript(STEALTH_SCRIPT)` **before** any page script runs.
 *
 * Purpose: raise the reCAPTCHA Enterprise score on `labs.google/fx` so Google
 * stops flagging the account with `PUBLIC_ERROR_UNUSUAL_ACTIVITY` / 403.
 *
 * Sources:
 *  - `sonrasa2k/flow-captcha-solver` (PyPI `flow-captcha-solver`) — `stealth.py`
 *  - dev.to "Playwright Stealth Mode in 2026: The 7 Patches That Actually Matter"
 *
 * Opt-out: set `VEO_STEALTH_DISABLED=1` to skip injection (used when debugging
 * suspected stealth-breakage, e.g. a site outright rejecting spoofed WebGL).
 *
 * Constraints when editing:
 *  - Must be self-contained ES5-ish JS (no TypeScript, no imports). The string
 *    is copy-pasted into page context; Playwright wraps it in a <script>.
 *  - Wrap every override in try/catch so a single failure (e.g. WebGL not
 *    available on headless) can't break the whole page bootstrapping.
 *  - Do NOT spoof values inconsistent with the real Chrome profile the user is
 *    signed into (e.g. never overwrite `navigator.userAgent` from here — it
 *    would clash with the Sec-CH-UA that Chrome sends, which is a much
 *    stronger detection signal than the webdriver flag).
 */
export const STEALTH_SCRIPT = `
(() => {
  try {
    // 1. Remove webdriver flag. The single most-used automation detector.
    //    We delete from the prototype too because "delete navigator.webdriver"
    //    by itself leaves it enumerable in some Chromium builds.
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
      // eslint-disable-next-line no-proto
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch (e) { /* ignore */ }

    // 2. navigator.plugins — Playwright/headless Chrome has 0 plugins; a real
    //    desktop Chrome reports at least Chrome PDF Viewer. Return a PluginArray
    //    lookalike with .length + indexed access + .item() / .namedItem().
    try {
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      fakePlugins.item = (i) => fakePlugins[i] || null;
      fakePlugins.namedItem = (n) => fakePlugins.find((p) => p.name === n) || null;
      Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins, configurable: true });
    } catch (e) { /* ignore */ }

    // 3. navigator.mimeTypes — parallel to plugins. Real Chrome has PDF MIMEs.
    try {
      const fakeMimes = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      ];
      fakeMimes.item = (i) => fakeMimes[i] || null;
      fakeMimes.namedItem = (n) => fakeMimes.find((m) => m.type === n) || null;
      Object.defineProperty(navigator, 'mimeTypes', { get: () => fakeMimes, configurable: true });
    } catch (e) { /* ignore */ }

    // 4. window.chrome runtime — Playwright headless leaves this undefined.
    //    Real Chrome (any mode) always exposes chrome.runtime + chrome.loadTimes.
    try {
      if (!window.chrome) window.chrome = {};
      if (!window.chrome.runtime) {
        window.chrome.runtime = {
          connect: () => ({}),
          sendMessage: () => undefined,
          onMessage: { addListener: () => undefined, removeListener: () => undefined },
          onConnect: { addListener: () => undefined, removeListener: () => undefined },
          PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
          id: undefined,
        };
      }
      if (!window.chrome.loadTimes) {
        const startT = Date.now() / 1000 - Math.random() * 200;
        window.chrome.loadTimes = () => ({
          requestTime: startT,
          startLoadTime: startT,
          commitLoadTime: startT + 0.001,
          finishDocumentLoadTime: startT + 0.5,
          finishLoadTime: startT + 1.2,
          firstPaintTime: startT + 0.6,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2',
        });
      }
      if (!window.chrome.csi) {
        window.chrome.csi = () => ({
          onloadT: Date.now(),
          pageT: 1000 + Math.random() * 500,
          startE: Date.now() - 1000,
          tran: 15,
        });
      }
      if (!window.chrome.app) {
        window.chrome.app = { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
      }
    } catch (e) { /* ignore */ }

    // 5. navigator.permissions.query — headless returns 'denied' for
    //    'notifications'; real Chrome returns whatever Notification.permission
    //    is. Mismatched answers here are a classic bot tell.
    try {
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default') });
          }
          return originalQuery.call(window.navigator.permissions, parameters);
        };
      }
    } catch (e) { /* ignore */ }

    // 6. WebGL vendor / renderer — headless returns 'Google Inc.' + 'Swift
    //    Shader'. Real Chrome on desktop reports an actual GPU driver string.
    //    Picking a common integrated GPU keeps the signature on the boring
    //    side of any bot-score histogram.
    try {
      const patchGetParameter = (proto) => {
        if (!proto) return;
        const orig = proto.getParameter;
        proto.getParameter = function (parameter) {
          // 37445 = UNMASKED_VENDOR_WEBGL, 37446 = UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
          return orig.call(this, parameter);
        };
      };
      patchGetParameter(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null);
      patchGetParameter(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null);
    } catch (e) { /* ignore */ }

    // 7. Miscellaneous navigator / screen fields. Real desktop Chrome reports
    //    hardwareConcurrency 4-16, deviceMemory 4-16, touch points 0.
    //    Headless leaks 'HeadlessChrome' in some internal strings — we can't
    //    override userAgent safely (mismatches Sec-CH-UA) but the rest helps.
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'], configurable: true });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
    } catch (e) { /* ignore */ }

    // 8. document.hidden / visibilityState — Chrome throttles background tab
    //    JS (including grecaptcha.enterprise.execute), leading to recaptcha
    //    capture timeouts when the user minimises the VEO window. Pinning
    //    both to "visible" sidesteps that throttle without requiring the
    //    user to keep the window focused.
    try {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    } catch (e) { /* ignore */ }

    // 9. iframe contentWindow — a popular detection pattern is to create a
    //    hidden iframe and read navigator.webdriver from inside it: the page
    //    patches above only affect the outer document. Override
    //    HTMLIFrameElement.contentWindow so the inner realm also returns
    //    webdriver=undefined. Wrapped in a getter to avoid breaking iframes
    //    that don't exist yet.
    try {
      const origCreateElement = Document.prototype.createElement;
      Document.prototype.createElement = function () {
        const el = origCreateElement.apply(this, arguments);
        try {
          if (el && el.tagName && el.tagName.toLowerCase() === 'iframe') {
            const origCW = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
            if (origCW && origCW.get) {
              Object.defineProperty(el, 'contentWindow', {
                configurable: true,
                get: function () {
                  const win = origCW.get.call(this);
                  try {
                    if (win && win.navigator) {
                      Object.defineProperty(win.navigator, 'webdriver', { get: () => undefined, configurable: true });
                    }
                  } catch (_) { /* ignore */ }
                  return win;
                },
              });
            }
          }
        } catch (_) { /* ignore */ }
        return el;
      };
    } catch (e) { /* ignore */ }

    // Confirmation ping the Node side reads back via page.evaluate after init.
    try { window.__wsuVeoStealthApplied = true; } catch (_) { /* ignore */ }
  } catch (e) {
    // Never throw — a broken stealth script must not take down the page.
  }
})();
`;
