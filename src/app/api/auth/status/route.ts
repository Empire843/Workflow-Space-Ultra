import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

import { NextResponse } from "next/server";

import { DATA_GENERAL_DIR, GROK_PROFILE_NAME } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface VeoCache {
  sessionId?: string;
  projectId?: string;
  accessToken?: string;
  updatedAt?: string;
}

interface GrokCacheEntry {
  custom_headers?: { "x-statsig-id"?: string };
  updated_at?: string;
}

interface GrokCacheFile {
  profiles?: Record<string, GrokCacheEntry>;
}

function safeRead<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function fileAge(file: string): number | null {
  try {
    if (!existsSync(file)) return null;
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export async function GET() {
  const veoFile = path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json");
  const grokFile = path.join(DATA_GENERAL_DIR, "grok_cache.json");

  const veo = safeRead<VeoCache>(veoFile);
  const veoOk = Boolean(veo?.sessionId && veo?.projectId && veo?.accessToken);

  const grok = safeRead<GrokCacheFile>(grokFile);
  const grokEntry = grok?.profiles?.[GROK_PROFILE_NAME];
  const grokOk = Boolean(grokEntry?.custom_headers?.["x-statsig-id"]);

  return NextResponse.json({
    veo: {
      ok: veoOk,
      updatedAt: veo?.updatedAt || null,
      ageMs: fileAge(veoFile),
      projectId: veo?.projectId || null,
    },
    grok: {
      ok: grokOk,
      profileName: GROK_PROFILE_NAME,
      updatedAt: grokEntry?.updated_at || null,
      ageMs: fileAge(grokFile),
    },
  });
}
