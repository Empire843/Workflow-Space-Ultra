import { NextResponse } from "next/server";

import {
  ensureDefaultChatGptClient,
  listClients,
  registerClient,
} from "@/server/oauth/clients";
import { requireLocalhost } from "@/server/oauth/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Localhost-only admin API for OAuth clients. Called from
 * `SettingsDialog.tsx`'s OAuth section. Mirrors CRUD semantics:
 *   GET  → list all clients (no secrets leaked — hashes stay on disk)
 *   POST → create a new client; response includes a one-shot plaintext secret
 *          the caller must stash before leaving the page.
 */

export async function GET(req: Request): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  ensureDefaultChatGptClient();
  const clients = listClients().map(({ secretHash, ...rest }) => {
    void secretHash;
    return rest;
  });
  return NextResponse.json({ clients });
}

export async function POST(req: Request): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  let body: { name?: string; redirectUris?: string[]; scopes?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  const redirectUris = Array.isArray(body.redirectUris)
    ? body.redirectUris.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["wsu:all"];
  const plain = registerClient(name, redirectUris, scopes);
  return NextResponse.json({
    client: {
      id: plain.id,
      name: plain.name,
      redirectUris: plain.redirectUris,
      scopes: plain.scopes,
    },
    secret: plain.secret,
  });
}
