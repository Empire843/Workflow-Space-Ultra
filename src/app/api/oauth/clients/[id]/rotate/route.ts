import { NextResponse } from "next/server";

import { rotateSecret } from "@/server/oauth/clients";
import { requireLocalhost } from "@/server/oauth/localGuard";
import { revokeAllForClient } from "@/server/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rotate a client's secret and revoke every existing token for that client
 * (tokens issued under the old secret stay valid against the hash store until
 * their TTL, but the caller has already indicated they want a hard reset).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  const { id } = await params;
  const result = rotateSecret(id);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  revokeAllForClient(id);
  return NextResponse.json({ secret: result.secret });
}
