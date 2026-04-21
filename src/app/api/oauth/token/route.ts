import { NextResponse } from "next/server";

import { getClient, verifyClientSecret } from "@/server/oauth/clients";
import { consumeAuthCode } from "@/server/oauth/codes";
import { issueTokenPair, rotateRefreshToken } from "@/server/oauth/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 token endpoint (RFC 6749 §4.1.3 + §6).
 *
 * Accepts:
 *   grant_type=authorization_code → exchange {code, redirect_uri, client auth,
 *                                             code_verifier?} for a token pair.
 *   grant_type=refresh_token       → exchange {refresh_token, client auth}
 *                                    for a brand new (rotated) pair.
 *
 * Client credentials may arrive either as HTTP Basic (`Authorization: Basic
 * base64(client_id:client_secret)`) or in the body (`client_id`,
 * `client_secret`). ChatGPT sends the former when "Basic auth" is chosen in
 * the GPT editor, the latter when "POST" is chosen.
 */

interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

function parseBasicAuth(header: string | null): ClientCreds | null {
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

function tokenError(
  error: string,
  description: string | undefined,
  status = 400,
): Response {
  return NextResponse.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    },
  );
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return new URLSearchParams(text);
  }
  if (contentType.includes("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body || {})) {
        if (v != null) params.set(k, String(v));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  // Try formData anyway — some clients send multipart.
  try {
    const form = await req.formData();
    const params = new URLSearchParams();
    form.forEach((v, k) => {
      if (typeof v === "string") params.set(k, v);
    });
    return params;
  } catch {
    return new URLSearchParams();
  }
}

function resolveClientCreds(req: Request, body: URLSearchParams): ClientCreds | null {
  const basic = parseBasicAuth(req.headers.get("authorization"));
  if (basic && basic.clientId && basic.clientSecret) return basic;
  const id = body.get("client_id");
  const secret = body.get("client_secret");
  if (id && secret) return { clientId: id, clientSecret: secret };
  return null;
}

export async function POST(req: Request): Promise<Response> {
  const params = await readParams(req);
  const grantType = params.get("grant_type") ?? "";

  const creds = resolveClientCreds(req, params);
  if (!creds) return tokenError("invalid_client", "missing client credentials", 401);
  const client = getClient(creds.clientId);
  if (!client) return tokenError("invalid_client", "unknown client_id", 401);
  if (!verifyClientSecret(creds.clientId, creds.clientSecret)) {
    return tokenError("invalid_client", "bad client_secret", 401);
  }

  if (grantType === "authorization_code") {
    const code = params.get("code");
    const redirectUri = params.get("redirect_uri");
    if (!code) return tokenError("invalid_request", "missing code");
    if (!redirectUri) return tokenError("invalid_request", "missing redirect_uri");
    const codeVerifier = params.get("code_verifier") ?? undefined;
    const result = consumeAuthCode({
      code,
      clientId: creds.clientId,
      redirectUri,
      codeVerifier,
    });
    if (!result.ok || !result.record) {
      const map: Record<string, { err: string; desc: string }> = {
        unknown_code: { err: "invalid_grant", desc: "code not recognised" },
        expired: { err: "invalid_grant", desc: "code expired" },
        used: { err: "invalid_grant", desc: "code already used" },
        client_mismatch: { err: "invalid_grant", desc: "code/client mismatch" },
        redirect_mismatch: { err: "invalid_grant", desc: "redirect_uri mismatch" },
        pkce_required: { err: "invalid_request", desc: "code_verifier required" },
        pkce_failed: { err: "invalid_grant", desc: "PKCE verification failed" },
      };
      const key = result.error ?? "unknown_code";
      const entry = map[key] ?? { err: "invalid_grant", desc: "code invalid" };
      return tokenError(entry.err, entry.desc);
    }
    const pair = issueTokenPair(creds.clientId, result.record.scopes);
    return NextResponse.json(
      {
        access_token: pair.accessToken,
        token_type: "bearer",
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scopes.join(" "),
      },
      { headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  }

  if (grantType === "refresh_token") {
    const refresh = params.get("refresh_token");
    if (!refresh) return tokenError("invalid_request", "missing refresh_token");
    const pair = rotateRefreshToken(refresh, creds.clientId);
    if (!pair) return tokenError("invalid_grant", "refresh_token invalid or expired");
    return NextResponse.json(
      {
        access_token: pair.accessToken,
        token_type: "bearer",
        expires_in: pair.expiresIn,
        refresh_token: pair.refreshToken,
        scope: pair.scopes.join(" "),
      },
      { headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  }

  return tokenError("unsupported_grant_type", `unknown grant_type '${grantType}'`);
}
