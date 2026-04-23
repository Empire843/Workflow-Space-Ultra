/**
 * Chrome manager for the Gemini Playwright video-analysis provider.
 *
 * Opens (or reuses) a dedicated Chrome profile logged into the user's
 * Google / Gemini Advanced account, landing on gemini.google.com/app so
 * the user can either log in (first run) or watch the automation happen.
 *
 * The file/variable names retain the "aistudio" prefix for backwards
 * compatibility with existing config env vars and cached profile dirs.
 */

import { existsSync, mkdirSync } from "node:fs";

import { openOrReuseChrome, type ChromeHandle } from "./processManager";
import { AISTUDIO_CDP_HOST, AISTUDIO_CDP_PORT, AISTUDIO_URL, AISTUDIO_USER_DATA_DIR } from "../config";

export async function openAiStudioChrome(): Promise<ChromeHandle> {
  if (!existsSync(AISTUDIO_USER_DATA_DIR)) mkdirSync(AISTUDIO_USER_DATA_DIR, { recursive: true });
  return openOrReuseChrome({
    userDataDir: AISTUDIO_USER_DATA_DIR,
    preferredPort: AISTUDIO_CDP_PORT,
    host: AISTUDIO_CDP_HOST,
    startUrl: AISTUDIO_URL,
    probeMatchUrl: "gemini.google.com",
  });
}
