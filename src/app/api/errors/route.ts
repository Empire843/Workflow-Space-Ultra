import { existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getErrorLogPath } from "@/server/telemetry/errorLog";

export const dynamic = "force-dynamic";

/**
 * GET /api/errors?limit=100
 *
 * Return the last N entries of the error log as JSON. The log file is JSON
 * Lines so we read from the tail in reverse to avoid loading the whole file
 * into memory when it has grown large.
 *
 * Query params:
 *   - limit: max entries to return (default 100, cap 1000)
 *   - since: ISO timestamp; only entries with ts > since are returned
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "100");
  const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? limitRaw : 100));
  const since = url.searchParams.get("since");
  const sinceMs = since ? Date.parse(since) : NaN;

  const file = getErrorLogPath();
  if (!existsSync(file)) {
    return NextResponse.json({ path: file, entries: [] });
  }

  try {
    const st = statSync(file);
    // Read the last ~1 MB by default; enough for several thousand entries.
    // Scale up if the caller asked for more, capped at 8 MB so a runaway
    // request cannot OOM the server.
    const readBytes = Math.min(st.size, Math.max(1_000_000, limit * 2_000));
    const start = Math.max(0, st.size - readBytes);
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(readBytes);
      await fh.read(buf, 0, readBytes, start);
      const text = buf.toString("utf-8");
      // Drop a potentially partial first line if we didn't start from 0.
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      if (start > 0 && lines.length > 0) lines.shift();
      const entries: unknown[] = [];
      for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as { ts?: string };
          if (Number.isFinite(sinceMs) && parsed.ts && Date.parse(parsed.ts) <= sinceMs) {
            break;
          }
          entries.push(parsed);
        } catch {
          // skip malformed line
        }
      }
      entries.reverse();
      return NextResponse.json({ path: file, size: st.size, entries });
    } finally {
      await fh.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ path: file, entries: [], error: msg }, { status: 500 });
  }
}
