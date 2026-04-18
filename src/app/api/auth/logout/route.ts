import path from "node:path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { NextResponse } from "next/server";

import { DATA_GENERAL_DIR, GROK_PROFILE_NAME } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GrokCacheFile {
  profiles?: Record<string, unknown>;
}

/**
 * Delete the token cache to force a re-login. Doesn't touch the Chrome profile (cookies remain),
 * the user just needs to click Verify again.
 */
export async function POST(req: Request) {
  const { target } = (await req.json().catch(() => ({}))) as { target?: "veo" | "grok" | "all" };
  const t = target || "all";

  if (t === "veo" || t === "all") {
    const f = path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json");
    if (existsSync(f)) unlinkSync(f);
  }
  if (t === "grok" || t === "all") {
    const f = path.join(DATA_GENERAL_DIR, "grok_cache.json");
    if (existsSync(f)) {
      try {
        const data = JSON.parse(readFileSync(f, "utf-8")) as GrokCacheFile;
        if (data.profiles) delete data.profiles[GROK_PROFILE_NAME];
        writeFileSync(f, JSON.stringify(data, null, 2), "utf-8");
      } catch {
        unlinkSync(f);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
