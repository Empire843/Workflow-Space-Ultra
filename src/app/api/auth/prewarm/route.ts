import { NextResponse } from "next/server";

import { GROK_PROFILE_NAME } from "@/server/config";
import { computeVeoHealth, computeGrokHealth } from "@/server/tokens/sessionHealth";
import { sessionTelemetry } from "@/server/tokens/sessionTelemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Non-blocking pre-warm endpoint.
 *
 * POST body: `{ targets: ("veo"|"grok")[] }`
 * Response: `202 { started: [...], skipped: [...] }` — the refresh itself
 * runs in the background so the client can move on immediately (pre-warm
 * is a courtesy; the 401 retry loop in Phase 3 is the actual safety net).
 *
 * In-flight dedupe — two concurrent POSTs for the same target share the
 * same pending Promise, so we never spin up two Chrome collectors at once
 * for the same provider. Honours the tri-state health to decide whether
 * the call needs `force: true`.
 */

type Target = "veo" | "grok";

const inflight: Map<Target, Promise<void>> = new Map();

async function prewarmVeo(force: boolean): Promise<void> {
  const started = Date.now();
  try {
    const { getVeoCollector } = await import("@/server/tokens/veoTokenCollector");
    const collector = await getVeoCollector();
    await collector.collectAuth({ force, timeoutMs: 45_000 });
    sessionTelemetry.record({
      target: "veo",
      kind: "prewarm",
      durationMs: Date.now() - started,
      detail: force ? "force" : "soft",
    });
  } catch (err) {
    sessionTelemetry.record({
      target: "veo",
      kind: "collect_fail",
      durationMs: Date.now() - started,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    // Swallow — background pre-warm failure shouldn't crash the dev server;
    // the user will see an amber → red badge on the next status poll.
    console.warn("[prewarm:veo] failed:", err instanceof Error ? err.message : err);
  }
}

async function prewarmGrok(force: boolean): Promise<void> {
  const started = Date.now();
  try {
    const { getGrokCollector } = await import("@/server/tokens/grokTokenCollector");
    const collector = await getGrokCollector(GROK_PROFILE_NAME);
    await collector.autoDiscoverStatsig({ force });
    sessionTelemetry.record({
      target: "grok",
      kind: "prewarm",
      durationMs: Date.now() - started,
      detail: force ? "force" : "soft",
    });
  } catch (err) {
    sessionTelemetry.record({
      target: "grok",
      kind: "collect_fail",
      durationMs: Date.now() - started,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    console.warn("[prewarm:grok] failed:", err instanceof Error ? err.message : err);
  }
}

function schedule(target: Target, force: boolean): boolean {
  if (inflight.has(target)) return false;
  const task = (target === "veo" ? prewarmVeo(force) : prewarmGrok(force)).finally(() => {
    inflight.delete(target);
  });
  inflight.set(target, task);
  return true;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { targets?: Target[]; force?: boolean };
  const requested: Target[] = Array.isArray(body.targets) ? body.targets : [];
  const valid = requested.filter((t): t is Target => t === "veo" || t === "grok");
  const forceFlag = Boolean(body.force);

  const started: Target[] = [];
  const skipped: Array<{ target: Target; reason: string }> = [];

  for (const target of valid) {
    const health = target === "veo" ? computeVeoHealth() : computeGrokHealth();
    // Decide whether to force a browser round-trip:
    //  - explicit `force: true` from caller (e.g. after a 401 retry)
    //  - status === "expired" (cache useless) — we still try, because the
    //    user may have just re-logged and Chrome is warm
    //  - status === "stale" — age past TTL*0.8, refresh proactively
    //  - status === "fresh" — soft call so collector at least primes its
    //    page handle + catches a dropped tab
    const force = forceFlag || health.status !== "fresh";
    const ok = schedule(target, force);
    if (ok) started.push(target);
    else skipped.push({ target, reason: "inflight" });
  }

  return NextResponse.json({ ok: true, started, skipped }, { status: 202 });
}

/**
 * GET — readonly peek at in-flight prewarm state, handy for debugging.
 */
export async function GET() {
  return NextResponse.json({
    inflight: Array.from(inflight.keys()),
  });
}
