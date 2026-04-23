/**
 * Chrome manager for ChatGPT Playwright provider.
 * Phase 2 stub — full implementation when ChatGPT Playwright provider is built.
 */

import { existsSync, mkdirSync } from "node:fs";

import { openOrReuseChrome, type ChromeHandle } from "./processManager";
import { CHATGPT_CDP_HOST, CHATGPT_CDP_PORT, CHATGPT_URL, CHATGPT_USER_DATA_DIR } from "../config";

export async function openChatGptChrome(): Promise<ChromeHandle> {
  if (!existsSync(CHATGPT_USER_DATA_DIR)) mkdirSync(CHATGPT_USER_DATA_DIR, { recursive: true });
  return openOrReuseChrome({
    userDataDir: CHATGPT_USER_DATA_DIR,
    preferredPort: CHATGPT_CDP_PORT,
    host: CHATGPT_CDP_HOST,
    startUrl: CHATGPT_URL,
    probeMatchUrl: "chatgpt.com",
  });
}
