import { NextResponse } from "next/server";

import { getClient, isRedirectUriAllowed } from "@/server/oauth/clients";
import { issueAuthCode } from "@/server/oauth/codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth 2.0 authorization endpoint (RFC 6749 §4.1.1 — authorization code grant).
 *
 *   GET  → validate incoming params, redirect the browser to `/oauth/consent`.
 *   POST → called by the consent page after the user picks Allow / Deny.
 *          Issues a single-use `code` on Allow, then 302s back to the client's
 *          `redirect_uri?code=...&state=...`. On Deny, 302s with
 *          `error=access_denied&state=...`.
 *
 * We stay permissive on `scope`: unknown scopes are ignored rather than
 * rejected so ChatGPT's default "profile openid" style requests don't
 * fail outright. All clients currently share one effective scope (`wsu:all`).
 */

interface ParsedAuthParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}

function parseParams(source: URLSearchParams): ParsedAuthParams {
  const method = source.get("code_challenge_method") ?? "";
  return {
    responseType: source.get("response_type") ?? "",
    clientId: source.get("client_id") ?? "",
    redirectUri: source.get("redirect_uri") ?? "",
    scope: source.get("scope") ?? "",
    state: source.get("state") ?? "",
    codeChallenge: source.get("code_challenge") ?? undefined,
    codeChallengeMethod:
      method === "S256" ? "S256" : method === "plain" ? "plain" : undefined,
  };
}

function errorHtml(title: string, detail: string): Response {
  const safeTitle = title.replace(/</g, "&lt;");
  const safeDetail = detail.replace(/</g, "&lt;");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>OAuth error</title>` +
      `<div style="font-family:system-ui;padding:32px;max-width:640px;margin:0 auto;color:#e4e4e7;background:#09090b;min-height:100vh;box-sizing:border-box;">` +
      `<h1 style="color:#fb7185;margin:0 0 8px">${safeTitle}</h1>` +
      `<p style="color:#a1a1aa">${safeDetail}</p>` +
      `<p style="color:#52525b;font-size:13px;margin-top:24px">Fix the issue in your ChatGPT Action configuration or in WSU Settings → OAuth Clients, then retry.</p>` +
      `</div>`,
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function redirectWithError(
  redirectUri: string,
  state: string,
  error: string,
  description?: string,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return NextResponse.redirect(u.toString(), 302);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const params = parseParams(url.searchParams);

  if (params.responseType !== "code") {
    return errorHtml(
      "Unsupported response_type",
      `Expected 'code', got '${params.responseType || "(empty)"}'.`,
    );
  }
  if (!params.clientId) return errorHtml("Missing client_id", "Add your WSU OAuth client id.");
  if (!params.redirectUri)
    return errorHtml("Missing redirect_uri", "ChatGPT must always supply a redirect_uri.");

  const client = getClient(params.clientId);
  if (!client) return errorHtml("Unknown client_id", "No such WSU OAuth client is registered.");
  if (!isRedirectUriAllowed(client, params.redirectUri)) {
    return errorHtml(
      "redirect_uri not allowed",
      `The URI '${params.redirectUri}' is not registered for client '${client.name}'. ` +
        `Add it under Settings → OAuth Clients → Redirect URIs.`,
    );
  }

  // Mandatory per OpenAI Actions spec.
  if (!params.state) {
    return redirectWithError(
      params.redirectUri,
      "",
      "invalid_request",
      "state parameter is required",
    );
  }

  const consent = new URL("/oauth/consent", url.origin);
  consent.searchParams.set("client_id", params.clientId);
  consent.searchParams.set("redirect_uri", params.redirectUri);
  consent.searchParams.set("state", params.state);
  if (params.scope) consent.searchParams.set("scope", params.scope);
  if (params.codeChallenge) consent.searchParams.set("code_challenge", params.codeChallenge);
  if (params.codeChallengeMethod)
    consent.searchParams.set("code_challenge_method", params.codeChallengeMethod);
  return NextResponse.redirect(consent.toString(), 302);
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return errorHtml("Invalid request body", "Expected form-encoded fields.");

  const decision = String(form.get("decision") ?? "");
  const source = new URLSearchParams();
  for (const key of [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "code_challenge",
    "code_challenge_method",
  ]) {
    const v = form.get(key);
    if (typeof v === "string") source.set(key, v);
  }
  if (!source.get("response_type")) source.set("response_type", "code");
  const params = parseParams(source);

  if (!params.clientId || !params.redirectUri) {
    return errorHtml("Missing params", "client_id and redirect_uri must be provided.");
  }
  const client = getClient(params.clientId);
  if (!client) return errorHtml("Unknown client_id", "No such WSU OAuth client is registered.");
  if (!isRedirectUriAllowed(client, params.redirectUri)) {
    return errorHtml("redirect_uri not allowed", "Hostile or stale redirect_uri.");
  }
  if (!params.state) {
    return redirectWithError(params.redirectUri, "", "invalid_request", "state required");
  }

  if (decision !== "allow") {
    return redirectWithError(params.redirectUri, params.state, "access_denied");
  }

  // Merge client scopes with requested scopes (intersection, fallback to client scopes).
  const requested = params.scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const effective = requested.length
    ? requested.filter((s) => client.scopes.includes(s))
    : client.scopes.slice();
  const grantedScopes = effective.length ? effective : client.scopes.slice();

  const code = issueAuthCode({
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scopes: grantedScopes,
    state: params.state,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
  });

  const back = new URL(params.redirectUri);
  back.searchParams.set("code", code);
  back.searchParams.set("state", params.state);
  return NextResponse.redirect(back.toString(), 302);
}
