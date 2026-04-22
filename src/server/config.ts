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

export const WINDOW_MODE: WindowMode =
  (process.env.CHROME_WINDOW_MODE as WindowMode) || "headful";

export const CHROME_EXE_PATH_ENV = process.env.CHROME_EXE_PATH || "";

export const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

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
