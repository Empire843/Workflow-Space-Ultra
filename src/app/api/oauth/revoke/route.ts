import { NextResponse } from "next/server";

import { getClient, verifyClientSecret } from "@/server/oauth/clients";
import { revokeToken } from "@/server/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 7009 token revocation endpoint.
 *
 * Required params (`application/x-www-form-urlencoded` or JSON):
 *   token            — the access or refresh token to revoke
 *   token_type_hint  — optional, currently ignored (we try both)
 * Plus client credentials (Basic Auth or body) — revocation is authenticated
 * so a leaked token URL can't be abused to DoS another tenant's tokens.
 *
 * Per spec we always return 200 on success, even if the token was already
 * unknown or expired.
 */

function parseBasicAuth(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header) return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[1], "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(await req.text());
  }
  if (ct.includes("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(body || {})) if (v != null) out.set(k, String(v));
      return out;
    } catch {
      return new URLSearchParams();
    }
  }
  try {
    const form = await req.formData();
    const out = new URLSearchParams();
    form.forEach((v, k) => {
      if (typeof v === "string") out.set(k, v);
    });
    return out;
  } catch {
    return new URLSearchParams();
  }
}

export async function POST(req: Request): Promise<Response> {
  const params = await readParams(req);
  const basic = parseBasicAuth(req.headers.get("authorization"));
  const clientId = basic?.clientId ?? params.get("client_id") ?? "";
  const clientSecret = basic?.clientSecret ?? params.get("client_secret") ?? "";

  if (!clientId || !clientSecret || !getClient(clientId)) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }
  if (!verifyClientSecret(clientId, clientSecret)) {
    return NextResponse.json({ error: "invalid_client" }, { status: 401 });
  }

  const token = params.get("token") ?? "";
  if (token) revokeToken(token);

  return new NextResponse(null, { status: 200 });
}
