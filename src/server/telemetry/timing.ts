/**
 * Lightweight timing telemetry for observability (Phase R0).
 *
 * Usage — wrap any async step:
 *
 *     const result = await timedSpan("veo.recaptcha", () => collector.getFreshRecaptchaToken(...), log);
 *
 * - Records duration + status (ok/error) into an in-memory ring buffer.
 * - Optionally emits `[timing] name=Xms` to the provided `log` callback (so it
 *   surfaces in the SSE job log, visible on each node).
 * - Aggregates (count / p50 / p95 / p99 / error-count) are exposed via
 *   `getSpanAggregates()` — consumed by `GET /api/jobs/metrics`.
 *
 * Deliberately dependency-free and process-local: no Prometheus, no DB. The
 * ring buffer caps memory; p50/p95 are computed on-demand from the buffer.
 */

export type SpanStatus = "ok" | "error";

export interface SpanEntry {
  name: string;
  durationMs: number;
  status: SpanStatus;
  at: number;
}

export interface SpanAggregate {
  name: string;
  count: number;
  errors: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastAt: number;
}

type LogFn = (msg: string) => void;

const RING_SIZE = 500;

interface RingState {
  buf: SpanEntry[];
  head: number;
  filled: boolean;
}

const GLOBAL_KEY = "__wsuTimingRing__";
type WithRing = typeof globalThis & { [GLOBAL_KEY]?: RingState };

function getRing(): RingState {
  const g = globalThis as WithRing;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { buf: new Array<SpanEntry>(RING_SIZE), head: 0, filled: false };
  }
  return g[GLOBAL_KEY]!;
}

function record(entry: SpanEntry): void {
  const ring = getRing();
  ring.buf[ring.head] = entry;
  ring.head = (ring.head + 1) % RING_SIZE;
  if (ring.head === 0) ring.filled = true;
}

/**
 * Run `fn` and record its wall-clock duration under `name`.
 *
 * If `log` is provided, emit a short one-liner when the span finishes so the
 * timing shows up inline in the SSE job log (operator-visible).
 */
export async function timedSpan<T>(name: string, fn: () => Promise<T>, log?: LogFn): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - started;
    record({ name, durationMs: duration, status: "ok", at: started });
    log?.(`[timing] ${name}=${duration}ms`);
    return result;
  } catch (err) {
    const duration = Date.now() - started;
    record({ name, durationMs: duration, status: "error", at: started });
    log?.(`[timing] ${name}=${duration}ms (error)`);
    throw err;
  }
}

/** Sync variant — used sparingly (most ops are async). */
export function timedSpanSync<T>(name: string, fn: () => T, log?: LogFn): T {
  const started = Date.now();
  try {
    const result = fn();
    const duration = Date.now() - started;
    record({ name, durationMs: duration, status: "ok", at: started });
    log?.(`[timing] ${name}=${duration}ms`);
    return result;
  } catch (err) {
    const duration = Date.now() - started;
    record({ name, durationMs: duration, status: "error", at: started });
    log?.(`[timing] ${name}=${duration}ms (error)`);
    throw err;
  }
}

/** Return every entry currently held in the ring (chronological order). */
export function getSpanEntries(): SpanEntry[] {
  const ring = getRing();
  if (!ring.filled) return ring.buf.slice(0, ring.head);
  return ring.buf.slice(ring.head).concat(ring.buf.slice(0, ring.head));
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Aggregate p50/p95/p99/error-count per span name, computed from the ring. */
export function getSpanAggregates(): SpanAggregate[] {
  const entries = getSpanEntries();
  const byName = new Map<string, SpanEntry[]>();
  for (const e of entries) {
    const arr = byName.get(e.name);
    if (arr) arr.push(e);
    else byName.set(e.name, [e]);
  }
  const out: SpanAggregate[] = [];
  for (const [name, arr] of byName) {
    const durations = arr.map((e) => e.durationMs).sort((a, b) => a - b);
    const errors = arr.filter((e) => e.status === "error").length;
    const total = durations.reduce((a, b) => a + b, 0);
    out.push({
      name,
      count: arr.length,
      errors,
      totalMs: total,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      maxMs: durations[durations.length - 1] ?? 0,
      lastAt: arr[arr.length - 1].at,
    });
  }
  out.sort((a, b) => b.totalMs - a.totalMs);
  return out;
}

/** Reset ring — used by tests only. */
export function resetSpans(): void {
  const g = globalThis as WithRing;
  delete g[GLOBAL_KEY];
}
