/**
 * UI-automation helpers for gemini.google.com/app.
 *
 * These are intentionally defensive — Gemini's DOM changes often, so each
 * step tries several selector candidates and uses keyboard shortcuts where
 * possible (more stable than clicking buttons whose aria-labels change).
 *
 * Shared contract:
 *   - All functions receive a `deadlineMs` (absolute wall-clock timestamp).
 *   - On failure (timeout / missing element) they throw with a human
 *     message explaining which stage broke — the provider wraps that into
 *     a localized error before bubbling it up to the client.
 */

import type { Page } from "playwright";

const GEMINI_APP_URL = "https://gemini.google.com/app";

// ── Navigation ────────────────────────────────────────────────────

/**
 * Navigates `page` to gemini.google.com/app and waits until the main prompt
 * textarea is present (reliable signal that the user is logged in and the
 * app chrome has finished mounting).
 */
export async function openGeminiNewChat(page: Page, deadlineMs: number): Promise<void> {
  const remaining = () => Math.max(0, deadlineMs - Date.now());

  await page.goto(GEMINI_APP_URL, {
    waitUntil: "domcontentloaded",
    timeout: Math.min(remaining(), 30_000),
  });

  // Wait for the rich-textarea / contenteditable editor to appear.
  await page.waitForSelector(PROMPT_EDITOR_SELECTOR, {
    state: "visible",
    timeout: Math.min(remaining(), 30_000),
  });
}

// ── File attachment ───────────────────────────────────────────────

/**
 * Uploads `videoPath` to gemini.google.com.
 *
 * Gemini does NOT keep an `<input type="file">` mounted at idle — it lazily
 * inserts one only after the user opens the "+" upload menu and picks
 * "Upload files".  The cleanest way to upload through that flow is to
 * intercept Chromium's native file-chooser dialog via Playwright's
 * `filechooser` event, which fires whenever any input[type=file] is
 * programmatically clicked.
 *
 * Strategy (in order):
 *   1. If an input[type=file] is already in the DOM, set files on it
 *      directly (some Gemini variants mount it eagerly).
 *   2. Otherwise: register a `filechooser` waiter, click the "+" button,
 *      then (if needed) click the "Upload files" menu item, and resolve
 *      the chooser with the video path.
 */
export async function uploadVideo(
  page: Page,
  videoPath: string,
  deadlineMs: number,
): Promise<void> {
  const remaining = () => Math.max(0, deadlineMs - Date.now());

  // ── Strategy 1: eager input ──
  const eagerInput = page.locator('input[type="file"]').first();
  const eagerCount = await eagerInput.count().catch(() => 0);
  if (eagerCount > 0) {
    try {
      await eagerInput.setInputFiles(videoPath, {
        timeout: Math.min(remaining(), 120_000),
      });
      await waitForUploadComplete(page, deadlineMs);
      return;
    } catch {
      // Fall through to menu-based strategy.
    }
  }

  // ── Strategy 2: open "+" menu, catch file chooser ──

  // Selector for the "+" / "Add files" button.  Gemini ships this as an
  // icon-only button with various aria-labels depending on locale; match
  // generously.  We also accept any toolbar button whose visible glyph is
  // "+", and the legacy `uploader-button` web-component.
  const addButton = page.locator(
    [
      'button[aria-label*="Add files" i]',
      'button[aria-label*="Add file" i]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Đính kèm" i]',
      'button[aria-label*="Tải lên" i]',
      'button[aria-label*="Thêm tệp" i]',
      'button[aria-label*="Thêm file" i]',
      'button[aria-label*="Insert" i]',
      'uploader-button button',
      'button[mattooltip*="Add" i]',
      'button[mattooltip*="Tải" i]',
    ].join(", "),
  ).first();

  await addButton.waitFor({
    state: "visible",
    timeout: Math.min(remaining(), 15_000),
  });

  // Set up filechooser listener BEFORE clicking — clicking the "Upload
  // files" menu item triggers a synthetic input.click() that fires the
  // chooser event.
  const chooserPromise = page.waitForEvent("filechooser", {
    timeout: Math.min(remaining(), 20_000),
  });

  await addButton.click();

  // After clicking "+", a menu may open with options like "Upload files",
  // "Tải tệp lên", "Add from Drive", etc.  Try to click an "Upload" item.
  // If the menu didn't open (e.g. the button itself triggers the chooser),
  // skip silently — the chooser event will fire either way.
  try {
    // Gemini uses Web Components now, so [role="menuitem"] might be hidden
    // in the shadow DOM. We use text piercing and known tags.
    const menuItem = page.locator(
      [
        'md-menu-item:has-text("Upload")',
        'md-menu-item:has-text("Tải")',
        '[role="menuitem"]:has-text("Upload")',
        '[role="menuitem"]:has-text("Tải tệp")',
        '[role="menuitem"]:has-text("Tải lên")',
        '[role="option"]:has-text("Upload")',
        '[role="option"]:has-text("Tải")',
        'button:has-text("Upload files")',
        'button:has-text("Tải tệp lên")',
        '.mat-mdc-menu-item:has-text("Upload")',
      ].join(", "),
    ).first();

    // If the above doesn't match, fallback to broad text search
    const textFallback = page.getByText(/Upload files?|Tải tệp lên|Tải lên/i).first();

    await Promise.any([
      menuItem.waitFor({ state: "visible", timeout: 4_000 }).then(() => menuItem.click({ timeout: 2_000 })),
      textFallback.waitFor({ state: "visible", timeout: 4_000 }).then(() => textFallback.click({ timeout: 2_000 }))
    ]);
  } catch {
    // No menu item — the click probably opened the chooser directly.
  }

  const chooser = await chooserPromise;
  await chooser.setFiles(videoPath, {
    timeout: Math.min(remaining(), 120_000),
  });

  await waitForUploadComplete(page, deadlineMs);
}

/**
 * Waits for Gemini to finish uploading + processing the just-attached
 * video.  We use the Send button's `disabled` state as the primary signal:
 * Gemini disables it while a file is uploading and re-enables it when the
 * file is fully processed and ready to be sent with a prompt.
 *
 * As a backup we also break out if any "uploading…" spinner inside the
 * composer goes away AND we've waited at least a small grace period — this
 * handles UI variants that don't toggle `disabled` cleanly.
 */
async function waitForUploadComplete(page: Page, deadlineMs: number): Promise<void> {
  const remaining = () => Math.max(0, deadlineMs - Date.now());

  // Give the composer a brief moment to switch into the "uploading" state
  // before we start polling for completion.  Without this we can race and
  // see a transient enabled state immediately after setFiles().
  await page.waitForTimeout(800);

  await page.waitForFunction(
    () => {
      // Find the Send button by its broad set of aria-labels (localized).
      const sendBtn = Array.from(document.querySelectorAll("button")).find((b) => {
        const lbl = (b.getAttribute("aria-label") || "").toLowerCase();
        return (
          lbl.includes("send message") ||
          lbl === "send" ||
          lbl.includes("gửi tin") ||
          lbl.includes("submit prompt") ||
          lbl.includes("gửi câu") ||
          lbl.includes("gửi prompt")
        );
      }) as HTMLButtonElement | undefined;

      if (sendBtn) {
        const ariaDisabled = sendBtn.getAttribute("aria-disabled");
        const isDisabled =
          sendBtn.disabled || ariaDisabled === "true";
        if (!isDisabled) return true;
      }

      // Backup signal: no upload spinner inside the composer area.
      const composerSpinner = document.querySelector(
        'input-area-v2 mat-progress-spinner, ' +
        'input-area-v2 [role="progressbar"], ' +
        '.composer-content mat-progress-spinner, ' +
        '.composer-content [role="progressbar"], ' +
        'uploader-file-preview mat-progress-spinner, ' +
        '.uploading',
      );
      if (!composerSpinner) {
        // No spinner AND no recognizable send button — fall back to
        // checking that any file/thumbnail element is present in the
        // composer area.
        const chip = document.querySelector(
          'input-area-v2 img, ' +
          'input-area-v2 video, ' +
          'uploader-file-preview, ' +
          '[data-test-id*="file" i], ' +
          '.file-preview-container, ' +
          'file-preview',
        );
        return !!chip;
      }
      return false;
    },
    null,
    { timeout: Math.max(1, remaining()), polling: 750 },
  );
}

// ── Prompt input ──────────────────────────────────────────────────

/**
 * Matches the rich-textarea used by gemini.google.com.  Gemini uses the
 * Quill editor under the hood, so its contenteditable div carries the
 * `ql-editor` class.  We also match generic contenteditable textbox as
 * a fallback.
 */
const PROMPT_EDITOR_SELECTOR =
  '.ql-editor[contenteditable="true"], ' +
  'rich-textarea [contenteditable="true"], ' +
  '[role="textbox"][contenteditable="true"]';

/**
 * Types `prompt` into the main chat editor and submits it.
 *
 * Submit uses Ctrl+Enter which is supported by Gemini across locales —
 * clicking the Send button is more fragile because its aria-label is
 * localized ("Send", "Gửi tin nhắn", ...).
 */
export async function sendPrompt(
  page: Page,
  prompt: string,
  deadlineMs: number,
): Promise<void> {
  const remaining = () => Math.max(0, deadlineMs - Date.now());

  const editor = page.locator(PROMPT_EDITOR_SELECTOR).first();
  await editor.waitFor({
    state: "visible",
    timeout: Math.min(remaining(), 30_000),
  });
  await editor.click();
  // Clear any placeholder / leftover text.
  await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
  await page.keyboard.press("Delete").catch(() => undefined);

  // Use page.keyboard.type for plain characters; for newlines we send
  // Shift+Enter so we don't submit prematurely.
  const lines = prompt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      await page.keyboard.type(lines[i], { delay: 0 });
    }
    if (i < lines.length - 1) {
      await page.keyboard.press("Shift+Enter");
    }
  }

  // Submit with Ctrl+Enter (Cmd+Enter on macOS is handled by ControlOrMeta).
  await page.keyboard.press("ControlOrMeta+Enter");
}

// ── Response waiting ──────────────────────────────────────────────

/**
 * Waits until Gemini finishes streaming its reply, then returns the raw
 * text of the last model response.
 *
 * Completion is detected by a 2-tier strategy:
 *   1. Primary:  wait for the "Stop generating" button to disappear.
 *   2. Stability: wait for the response element's textContent to stop
 *      changing for `STABILITY_WINDOW_MS` — this catches edge cases where
 *      Gemini keeps the Stop button around briefly after the last token.
 */
const STABILITY_WINDOW_MS = 3_000;
const STABILITY_POLL_MS = 500;

export async function waitForResponseText(
  page: Page,
  deadlineMs: number,
): Promise<string> {
  const remaining = () => Math.max(0, deadlineMs - Date.now());

  // Strategy 1: wait for the Stop button to go away.
  //
  // The Stop button's aria-label is localized: "Stop response", "Dừng
  // phản hồi", etc.  We match case-insensitively on "stop" / "dừng".
  try {
    await page.waitForFunction(
      () => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const stopping = buttons.some((b) => {
          const label = (b.getAttribute("aria-label") || b.textContent || "").toLowerCase();
          return label.includes("stop") || label.includes("dừng") || label.includes("dung");
        });
        return !stopping;
      },
      null,
      { timeout: Math.max(1, remaining()), polling: 500 },
    );
  } catch {
    // Fall through to stability check — maybe Gemini never rendered a
    // Stop button (quick response).
  }

  // Strategy 2: stability check on the latest assistant message.
  const readResponse = (): Promise<string> =>
    page.evaluate(() => {
      // Gemini renders each assistant reply inside a <model-response> or
      // a container with class `model-response-text`.  We try several
      // selectors and fall back to the last `.markdown` block.
      const candidates = [
        "model-response",
        "message-content",
        ".model-response-text",
        ".markdown",
      ];
      for (const sel of candidates) {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length === 0) continue;
        const last = nodes[nodes.length - 1] as HTMLElement;
        const text = (last.innerText || last.textContent || "").trim();
        if (text) return text;
      }
      return "";
    });

  let lastText = "";
  let stableSince = 0;
  while (remaining() > 0) {
    const now = Date.now();
    const current = await readResponse().catch(() => "");
    if (current && current === lastText) {
      if (stableSince === 0) stableSince = now;
      if (now - stableSince >= STABILITY_WINDOW_MS) {
        return current;
      }
    } else {
      lastText = current;
      stableSince = current ? now : 0;
    }
    await new Promise((r) => setTimeout(r, STABILITY_POLL_MS));
  }

  if (lastText) return lastText;
  throw new Error(
    "Gemini không trả về response trong deadline. " +
    "Có thể video quá dài, mạng chậm, hoặc Gemini Advanced của bạn đã hết quota ngày.",
  );
}
