/**
 * Chrome manager for AI Studio Playwright provider.
 * Phase 2 stub — full implementation when Gemini Playwright provider is built.
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
    probeMatchUrl: "aistudio.google.com",
  });
}
