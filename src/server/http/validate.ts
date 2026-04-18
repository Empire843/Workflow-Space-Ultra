import { NextResponse } from "next/server";
import type { ZodSchema } from "zod";

/**
 * Parse a JSON request body and validate against a Zod schema.
 * On failure returns a `NextResponse` ready to be returned from the handler;
 * on success returns the parsed value. Use the `in ("response" in result)`
 * pattern at call-sites (see /api/jobs).
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<{ data: T } | { response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      response: NextResponse.json(
        { ok: false, message: "Invalid JSON body" },
        { status: 400 },
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          message: "Validation failed",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data };
}
