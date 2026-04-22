import { NextResponse } from "next/server";

import { computeVeoHealth, computeGrokHealth } from "@/server/tokens/sessionHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tri-state session health endpoint.
 *
 * Response shape (additive):
 *   veo:  { status, ageMs, updatedAt, chromeConnected, projectId, ok }
 *   grok: { status, ageMs, updatedAt, chromeConnected, profileName, ok }
 *
 * `ok` is kept for backward compat (= status !== "expired"). The client
 * should prefer `status` directly so it can show the amber "refresh soon"
 * state.
 */
export async function GET() {
  const veo = computeVeoHealth();
  const grok = computeGrokHealth();

  return NextResponse.json({
    veo: {
      status: veo.status,
      ageMs: veo.ageMs,
      updatedAt: veo.updatedAt,
      chromeConnected: veo.chromeConnected,
      projectId: veo.projectId ?? null,
      ok: veo.status !== "expired",
    },
    grok: {
      status: grok.status,
      ageMs: grok.ageMs,
      updatedAt: grok.updatedAt,
      chromeConnected: grok.chromeConnected,
      profileName: grok.profileName,
      ok: grok.status !== "expired",
    },
  });
}
