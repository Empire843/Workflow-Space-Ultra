import { NextResponse } from "next/server";

import { GROK_PROFILE_NAME } from "@/server/config";
import { getGrokCollector } from "@/server/tokens/grokTokenCollector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const col = await getGrokCollector(GROK_PROFILE_NAME);
    const headers = await col.autoDiscoverStatsig();
    const preview = headers["x-statsig-id"].slice(0, 18);
    return NextResponse.json({ ok: true, message: `x-statsig-id=${preview}…` });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
