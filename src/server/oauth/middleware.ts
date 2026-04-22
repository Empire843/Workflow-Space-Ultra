import { validateAccessToken, type ValidatedAccess } from "./tokens";

/**
 * Bearer-token gate for /api/actions/* endpoints. On success returns the
 * validated access context (clientId + scopes). On failure returns a `Response`
 * the caller should return directly — so the typical usage pattern is:
 *
 *   const auth = requireOAuth(req);
 *   if (auth instanceof Response) return auth;
 *   // auth.clientId, auth.scopes
 */

export function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function unauthorized(error: string, description?: string): Response {
  const challengeParts = [`Bearer realm="wsu-actions"`, `error="${error}"`];
  if (description) challengeParts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": challengeParts.join(", "),
      },
    },
  );
}

export function requireOAuth(req: Request): ValidatedAccess | Response {
  const header = req.headers.get("authorization");
  const token = extractBearerToken(header);
  if (!token) return unauthorized("invalid_request", "missing Bearer token");
  const result = validateAccessToken(token);
  if (!result.ok) {
    const map: Record<string, string> = {
      missing: "missing token",
      not_found: "token not recognised",
      expired: "token expired",
      revoked: "token revoked",
      wrong_type: "refresh token used as bearer",
    };
    return unauthorized("invalid_token", map[result.reason] ?? "invalid token");
  }
  return result;
}

