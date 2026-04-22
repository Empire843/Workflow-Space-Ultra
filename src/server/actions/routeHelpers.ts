import { NextResponse } from "next/server";
import { z } from "zod";

import { requireOAuth } from "@/server/oauth/middleware";

/**
 * Thin wrappers shared by every `/api/actions/*` route:
 *   - enforce OAuth via `requireOAuth`
 *   - parse JSON body against a zod schema built from a Shape
 *   - translate thrown errors into JSON 500 responses
 *
 * Keeping these helpers centralised means each route file stays 10–20 lines
 * and the security gate can never be forgotten by copy-paste.
 */

export function jsonError(status: number, error: string, description?: string): Response {
  return NextResponse.json({ error, error_description: description }, { status });
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) {
    // Fall back to trying anyway — some clients omit the header.
  }
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export function parseWithShape<S extends z.ZodRawShape>(
  shape: S,
  body: unknown,
): { ok: true; data: z.infer<z.ZodObject<S>> } | { ok: false; error: Response } {
  const parsed = z.object(shape).safeParse(body ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: jsonError(
        400,
        "invalid_request",
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      ),
    };
  }
  return { ok: true, data: parsed.data as z.infer<z.ZodObject<S>> };
}

export function runSafe<T>(fn: () => Promise<T>): Promise<Response> {
  return fn()
    .then((data) => NextResponse.json(data))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[actions] handler failed: ${message}`);
      return jsonError(500, "internal_error", message);
    });
}

/**
 * Combined guard: returns `{ ok: false, response }` if OAuth fails. Otherwise
 * returns `{ ok: true, auth }` with the validated access context.
 */
export function gate(req: Request):
  | { ok: true; auth: { clientId: string; scopes: string[] } }
  | { ok: false; response: Response } {
  const auth = requireOAuth(req);
  if (auth instanceof Response) return { ok: false, response: auth };
  return { ok: true, auth: { clientId: auth.clientId, scopes: auth.scopes } };
}
