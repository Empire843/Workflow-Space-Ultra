/**
 * Bounded ring buffer of session-lifecycle events — used by the Veo/Grok
 * debug endpoints to show recent behaviour when the user reports "session
 * died again".
 *
 * Intentionally in-memory only: this is diagnostic, not audit. A server
 * restart drops the history — fine, because the cache files on disk hold
 * the durable state.
 *
 * Stored on `globalThis` so Next.js dev-mode HMR doesn't reset the buffer
 * every time we edit a file (same trick as the token collectors).
 */

export type SessionTarget = "veo" | "grok";

export type SessionEventKind =
  | "collect_ok"
  | "collect_fail"
  | "cache_hit"
  | "cache_stale"
  | "invalidate"
  | "retry_401"
  | "reset_collector"
  | "logout"
  | "prewarm"
  | "preflight_fail";

export interface SessionEvent {
  ts: number;
  target: SessionTarget;
  kind: SessionEventKind;
  durationMs?: number;
  detail?: string;
}

const MAX_ENTRIES_PER_TARGET = 200;
const GLOBAL_KEY = "__wsuSessionTelemetry__";

interface TelemetryStore {
  veo: SessionEvent[];
  grok: SessionEvent[];
}

function getStore(): TelemetryStore {
  const g = globalThis as unknown as Record<string, TelemetryStore | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { veo: [], grok: [] };
  return g[GLOBAL_KEY]!;
}

function push(store: TelemetryStore, ev: SessionEvent) {
  const bucket = ev.target === "veo" ? store.veo : store.grok;
  bucket.push(ev);
  // Keep only the newest N — cheap splice from the front; 200 is small
  // enough that the cost is immaterial even under heavy bursts.
  if (bucket.length > MAX_ENTRIES_PER_TARGET) {
    bucket.splice(0, bucket.length - MAX_ENTRIES_PER_TARGET);
  }
}

export const sessionTelemetry = {
  record(ev: Omit<SessionEvent, "ts"> & { ts?: number }): void {
    const entry: SessionEvent = { ts: ev.ts ?? Date.now(), ...ev };
    push(getStore(), entry);
  },
  recent(target: SessionTarget, limit: number = 50): SessionEvent[] {
    const store = getStore();
    const bucket = target === "veo" ? store.veo : store.grok;
    const n = Math.min(Math.max(1, limit | 0), bucket.length);
    return bucket.slice(-n);
  },
  clear(target?: SessionTarget): void {
    const store = getStore();
    if (!target) {
      store.veo.length = 0;
      store.grok.length = 0;
      return;
    }
    if (target === "veo") store.veo.length = 0;
    else store.grok.length = 0;
  },
};
