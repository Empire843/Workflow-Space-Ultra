import { NextResponse } from "next/server";

import { cancelQueuedTasks, getLaneStats, resetAllLanes } from "@/server/lanes";
import { getCooldownSnapshot, resetCooldown } from "@/server/providers/veo/cooldown";
import {
  cancelAllActiveJobs,
  clearFinishedJobs,
  listJobs,
} from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/queue
 *
 * Snapshot of the in-memory queue:
 *   - `lanes`: per-provider concurrency + active + queued count.
 *   - `jobs`:  every tracked job (queued / running / done / error / cancelled),
 *              newest first.
 *
 * Powers the client-side Queue panel so users can see exactly what the server
 * is doing and cancel stuck work.
 *
 * The client may add `?active=1` to filter out finished jobs client-side; we
 * always return the full list so the panel can show a "recently completed"
 * section too.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    lanes: getLaneStats(),
    jobs: listJobs(),
    // Cooldown exposes a countdown for the UI so users can see "Google is
    // rate-limiting, Xs left" instead of a blank spinner.
    veoCooldown: getCooldownSnapshot(),
    now: Date.now(),
  });
}

/**
 * DELETE /api/queue
 *
 * Two actions via query string:
 *   - (default)            → cancel every queued/running job AND drop queued
 *                            lane tasks. Running jobs will abort at the next
 *                            cancel check in the executor.
 *   - `?clearFinished=1`   → only sweep jobs in a terminal state.
 *   - `?reset=1`           → nuke lanes (`active := 0`) as a last-resort when
 *                            an old build left counters stuck. Destructive.
 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("clearFinished") === "1") {
    const removed = clearFinishedJobs();
    return NextResponse.json({ ok: true, action: "clearFinished", removed });
  }
  if (url.searchParams.get("reset") === "1") {
    const cancelled = cancelAllActiveJobs();
    const reset = resetAllLanes();
    // Force-reset should also clear the VEO cooldown — otherwise a user
    // trying to recover from a stuck state still has to wait for Google.
    resetCooldown();
    return NextResponse.json({ ok: true, action: "reset", cancelled, reset });
  }
  if (url.searchParams.get("clearCooldown") === "1") {
    resetCooldown();
    return NextResponse.json({ ok: true, action: "clearCooldown" });
  }
  const cancelled = cancelAllActiveJobs();
  const dropped = cancelQueuedTasks();
  return NextResponse.json({ ok: true, action: "cancelAll", cancelled, dropped });
}
