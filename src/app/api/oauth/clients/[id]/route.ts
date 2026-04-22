import { NextResponse } from "next/server";

import { deleteClient, getClient, setRedirectUris } from "@/server/oauth/clients";
import { requireLocalhost } from "@/server/oauth/localGuard";
import { revokeAllForClient } from "@/server/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  const { id } = await params;
  let body: { redirectUris?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!Array.isArray(body.redirectUris)) {
    return NextResponse.json({ error: "redirectUris_required" }, { status: 400 });
  }
  const updated = setRedirectUris(id, body.redirectUris);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { secretHash: _omit, ...safe } = updated;
  void _omit;
  return NextResponse.json({ client: safe });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  const { id } = await params;
  const client = getClient(id);
  if (!client) return NextResponse.json({ error: "not_found" }, { status: 404 });
  revokeAllForClient(id);
  deleteClient(id);
  return NextResponse.json({ ok: true });
}
