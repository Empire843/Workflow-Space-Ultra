import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { initOAuth } from "./oauth/storage";
import { initOAuthUrls } from "./oauth/urls";

export type AccountType = "NORMAL" | "PRO" | "ULTRA";
export type WindowMode = "headful" | "offscreen" | "headless";

export const BASE_DIR = process.cwd();

export const DATA_GENERAL_DIR = path.join(BASE_DIR, "data_general");
export const DOWNLOADS_DIR = path.join(BASE_DIR, "downloads");
export const WORKFLOWS_DIR = path.join(BASE_DIR, "Workflows");
export const LOGS_DIR = path.join(BASE_DIR, "logs");

// Chrome profiles (keep the original Python tool's names so users can share profiles)
export const VEO_USER_DATA_DIR = process.env.VEO_CHROME_USER_DATA_DIR
  ? path.resolve(BASE_DIR, process.env.VEO_CHROME_USER_DATA_DIR)
  : path.join(BASE_DIR, "chrome_user_data");

export const GROK_USER_DATA_ROOT = process.env.GROK_CHROME_USER_DATA_ROOT
  ? path.resolve(BASE_DIR, process.env.GROK_CHROME_USER_DATA_ROOT)
  : path.join(BASE_DIR, "chrome_user_data_grok");

export const GROK_PROFILE_NAME = process.env.GROK_PROFILE_NAME || "PROFILE_1";

export const VEO_CDP_HOST = process.env.VEO_CDP_HOST || "127.0.0.1";
export const VEO_CDP_PORT = Number(process.env.VEO_CDP_PORT || 9222);
export const GROK_CDP_HOST = process.env.GROK_CDP_HOST || "127.0.0.1";
export const GROK_CDP_PORT = Number(process.env.GROK_CDP_PORT || 9223);

export const VEO_FLOW_URL = process.env.VEO_FLOW_URL || "https://labs.google/fx/vi/tools/flow";
export const GROK_URL = process.env.GROK_URL || "https://grok.com/";

// Clone Video — ChatGPT Playwright
export const CHATGPT_USER_DATA_DIR = process.env.CHATGPT_CHROME_USER_DATA_DIR
  ? path.resolve(BASE_DIR, process.env.CHATGPT_CHROME_USER_DATA_DIR)
  : path.join(BASE_DIR, "chrome_user_data_chatgpt");
export const CHATGPT_CDP_HOST = process.env.CHATGPT_CDP_HOST || "127.0.0.1";
export const CHATGPT_CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9225);
export const CHATGPT_URL = process.env.CHATGPT_URL || "https://chatgpt.com/";

// Clone Video — AI Studio Playwright
export const AISTUDIO_USER_DATA_DIR = process.env.AISTUDIO_CHROME_USER_DATA_DIR
  ? path.resolve(BASE_DIR, process.env.AISTUDIO_CHROME_USER_DATA_DIR)
  : path.join(BASE_DIR, "chrome_user_data_aistudio");
export const AISTUDIO_CDP_HOST = process.env.AISTUDIO_CDP_HOST || "127.0.0.1";
export const AISTUDIO_CDP_PORT = Number(process.env.AISTUDIO_CDP_PORT || 9224);
export const AISTUDIO_URL = process.env.AISTUDIO_URL || "https://gemini.google.com/app";

export const WINDOW_MODE: WindowMode =
  (process.env.CHROME_WINDOW_MODE as WindowMode) || "headful";

export const CHROME_EXE_PATH_ENV = process.env.CHROME_EXE_PATH || "";

export const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

/**
 * VEO Strike Prevention Hardening — runtime-tunable env vars (all optional).
 *
 * These are read directly from `process.env` at the point of use (not
 * persisted to `config.json`) because they are operational knobs tuned
 * per-deployment / per-debug-session, not per-user settings.
 *
 *   VEO_STEALTH_DISABLED = "1"
 *     Skip injecting `STEALTH_SCRIPT` into the Playwright context.
 *     Use only when debugging a suspected stealth-induced breakage.
 *
 *   VEO_THROTTLE_MS = number (default 20000)
 *     Base inter-request spacing between successive VEO calls. Kept at
 *     ~20s so a single account doesn't burn its daily risk budget.
 *
 *   VEO_THROTTLE_JITTER_MS = number (default 2500)
 *     Half-width of the random jitter applied on top of VEO_THROTTLE_MS
 *     (so the actual wait is 20000 ± up to 2500ms). Set to 0 to disable.
 *
 *   VEO_CLEAR_STORAGE_EVERY = number (default 6, 0 disables)
 *     How many successful captures per mode before we proactively wipe
 *     `labs.google/fx` site storage. Mirrors Python `CLEAR_DATA_EVERY`.
 *
 *   VEO_PRECAPTURE_JITTER_MIN_MS = number (default 300)
 *   VEO_PRECAPTURE_JITTER_MAX_MS = number (default 1000)
 *     Random human-pause applied right before we trigger the Flow
 *     "Tạo" click. Set the max to 0 to disable the jitter entirely.
 *
 * Full operational notes live in `wiki/reference/env-vars.md` and
 * `wiki/operations/debugging-veo.md`.
 */


/**
 * Public base URL the WSU server is reachable at from the outside world.
 * Required when exposing WSU as a ChatGPT Custom GPT Action — ChatGPT's
 * servers must be able to hit `/api/oauth/*` and `/api/actions/*`, so the
 * user runs a tunnel (ngrok / cloudflared / tailscale) and points this env
 * at the public hostname.
 *
 * Falls back to localhost for development. When localhost is used, the
 * Settings UI shows a warning so the user knows the ChatGPT flow will not
 * actually work end-to-end until a tunnel is set up.
 */
export const PUBLIC_BASE_URL = (
  process.env.WSU_PUBLIC_BASE_URL || "http://localhost:3000"
).replace(/\/+$/, "");

// ── OAuth URL helpers — re-exported for backward compat ──────────
// The canonical source is now `@/server/oauth/urls` (self-contained module).
export { isPublicBaseUrlLocal, oauthPublicUrls } from "./oauth/urls";



export const CONFIG_FILE = path.join(DATA_GENERAL_DIR, "config.json");

export function ensureDirs() {
  for (const d of [DATA_GENERAL_DIR, DOWNLOADS_DIR, WORKFLOWS_DIR, LOGS_DIR, VEO_USER_DATA_DIR, GROK_USER_DATA_ROOT]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  // Bootstrap the OAuth module with the app's data dir + public URL.
  initOAuth({ dataDir: DATA_GENERAL_DIR });
  initOAuthUrls(PUBLIC_BASE_URL);
}

export interface AppConfig {
  account1: {
    TYPE_ACCOUNT: AccountType;
    projectId?: string;
    sessionId?: string;
    video_model_key_landscape?: string;
    video_model_key_portrait?: string;
  };
  CREATE_IMAGE_MODEL?: string;
  SEED_MODE?: "Random" | "Fixed";
  SEED_VALUE?: number;
  VEO_CONCURRENCY?: number;
  GROK_CONCURRENCY?: number;
  /**
   * Nơi "Download" ghi file ra khi user bấm nút tải. File gốc vẫn nằm nguyên
   * trong `Workflows/<id>/assets/outputs/` (internal cache cho preview + re-run),
   * nên app không thể thay thế bằng `move`. Thay vào đó `/api/assets/export`
   * tạo **hardlink** vào thư mục này — cùng ổ đĩa thì 0 byte thêm, khác ổ thì
   * tự fallback sang `fs.copyFile`.
   *
   * Để trống → nút Download rơi về hành vi cũ (browser download vào thư mục
   * Downloads mặc định của OS).
   */
  EXPORT_DIR?: string;

  // ── Clone Video settings ──────────────────────────────────────
  /** Gemini API key from https://aistudio.google.com/apikey (free). */
  GEMINI_API_KEY?: string;
  /** Which provider to use for video analysis. */
  VIDEO_ANALYZER_PROVIDER?: "gemini-api" | "gemini-playwright" | "chatgpt-playwright";
  /** Which Gemini model to use for analysis. */
  GEMINI_MODEL?: "gemini-2.5-flash" | "gemini-2.5-pro";

  // ── Clone Video → Clone TTS (voice-over) ───────────────────────
  // Reuses GEMINI_API_KEY above. Kept as a narrow union of the three preview
  // TTS IDs exposed on aistudio — anything outside the list should go through
  // the Settings UI, not a raw string poke. Default is the newest (3.1).
  GEMINI_TTS_MODEL?:
    | "gemini-3.1-flash-tts-preview"
    | "gemini-2.5-flash-preview-tts"
    | "gemini-2.5-pro-preview-tts";
  /** Prebuilt voice name (e.g. Kore / Puck / Aoede). See GEMINI_TTS_VOICES. */
  GEMINI_TTS_VOICE?: string;
  /**
   * BCP-47 language code for TTS synthesis (e.g. "vi-vn", "en-us"). Special
   * value "auto" (default) omits the field so Gemini infers from the text —
   * this is usually what you want because the narration is already in the
   * original language of the source video.
   */
  GEMINI_TTS_LANGUAGE?: string;
}

const DEFAULT_CONFIG: AppConfig = {
  account1: {
    TYPE_ACCOUNT: (process.env.VEO_TYPE_ACCOUNT as AccountType) || "ULTRA",
    projectId: process.env.VEO_PROJECT_ID || undefined,
    sessionId: process.env.VEO_SESSION_ID || undefined,
  },
  CREATE_IMAGE_MODEL: "Nano Banana 2",
  SEED_MODE: "Random",
  SEED_VALUE: 9797,
  VEO_CONCURRENCY: 1,
  GROK_CONCURRENCY: 1,
};

export function loadConfig(): AppConfig {
  ensureDirs();
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw) as AppConfig;
      return { ...DEFAULT_CONFIG, ...parsed, account1: { ...DEFAULT_CONFIG.account1, ...(parsed.account1 || {}) } };
    }
  } catch {
    // ignore
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AppConfig) {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}
