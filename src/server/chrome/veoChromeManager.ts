import { existsSync, mkdirSync } from "node:fs";

import { openOrReuseChrome, type ChromeHandle } from "./processManager";
import { VEO_CDP_HOST, VEO_CDP_PORT, VEO_FLOW_URL, VEO_USER_DATA_DIR } from "../config";

export async function openVeoChrome(opts?: { startUrl?: string }): Promise<ChromeHandle> {
  if (!existsSync(VEO_USER_DATA_DIR)) mkdirSync(VEO_USER_DATA_DIR, { recursive: true });
  return openOrReuseChrome({
    userDataDir: VEO_USER_DATA_DIR,
    preferredPort: VEO_CDP_PORT,
    host: VEO_CDP_HOST,
    startUrl: opts?.startUrl || VEO_FLOW_URL,
    lang: "en-US",
    probeMatchUrl: "labs.google/fx",
  });
}
