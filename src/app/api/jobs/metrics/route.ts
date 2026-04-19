import { NextResponse } from "next/server";

import { getSpanAggregates, getSpanEntries, resetSpans } from "@/server/telemetry/timing";

/**
 * GET /api/jobs/metrics — snapshot of the in-memory timing ring buffer.
 *
 * Query:
 *   ?entries=1 → also return the last N raw entries (default omitted)
 *
 * Used by the benchmark scripts + operator to inspect where time is spent
 * (recaptcha vs API vs poll vs download) across the last ~500 span events.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeEntries = url.searchParams.get("entries") === "1";
  const aggregates = getSpanAggregates();
  return NextResponse.json(
    {
      aggregates,
      ...(includeEntries ? { entries: getSpanEntries() } : {}),
      now: Date.now(),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

/**
 * DELETE /api/jobs/metrics — clear the ring buffer.
 *
 * Use this **before** running a benchmark workflow to get clean numbers,
 * especially after upgrading/redeploying telemetry (older entries predating
 * the new span wraps can skew error-rate aggregates).
 */
export async function DELETE() {
  resetSpans();
  return NextResponse.json({ ok: true, clearedAt: Date.now() });
}
