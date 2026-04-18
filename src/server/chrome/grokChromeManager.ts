import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

import { openOrReuseChrome, type ChromeHandle } from "./processManager";
import {
  GROK_CDP_HOST,
  GROK_CDP_PORT,
  GROK_PROFILE_NAME,
  GROK_URL,
  GROK_USER_DATA_ROOT,
} from "../config";

/**
 * Port of grok_chrome_manager.py:
 * - Resolve profile dir: <root>/<profile_name>
 * - Open Chrome offscreen, CDP, connect via processManager
 */

export function resolveGrokProfileDir(profileName?: string): string {
  const name = (profileName || GROK_PROFILE_NAME).trim() || "PROFILE_1";
  if (!existsSync(GROK_USER_DATA_ROOT)) mkdirSync(GROK_USER_DATA_ROOT, { recursive: true });
  return path.join(GROK_USER_DATA_ROOT, name);
}

export async function openGrokChrome(opts?: {
  profileName?: string;
  startUrl?: string;
}): Promise<ChromeHandle> {
  const userDataDir = resolveGrokProfileDir(opts?.profileName);
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
  return openOrReuseChrome({
    userDataDir,
    preferredPort: GROK_CDP_PORT,
    host: GROK_CDP_HOST,
    startUrl: opts?.startUrl || GROK_URL,
    lang: "vi",
    probeMatchUrl: "grok.com",
  });
}
