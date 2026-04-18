import { NODE_CATALOG, type NodeKind, type ProviderId } from "@/lib/nodes";
import { loadConfig } from "./config";

/**
 * Per-provider concurrency lanes.
 *
 * Why lanes are needed:
 *  - VEO reCAPTCHA token acquisition is already serialized through a single Playwright
 *    page; running multiple VEO jobs in parallel doesn't actually speed things up and
 *    risks being flagged by Google with PUBLIC_ERROR_UNUSUAL_ACTIVITY.
 *  - Grok uses its own Chrome/profile → can run in parallel with VEO.
 *  - Local transformations (ffmpeg, remove-bg ...) don't need a limit.
 *
 * Default: VEO=1, Grok=1, Local=unbounded. Users can tune this in Settings.
 */

type LaneTask<T = unknown> = {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
};

interface Lane {
  concurrency: number;
  active: number;
  queue: LaneTask[];
}

const DEFAULT_CONCURRENCY: Record<ProviderId, number> = {
  veo: 1,
  grok: 1,
  local: 8,
};

const g = globalThis as unknown as { __wsu_lanes?: Record<ProviderId, Lane> };

function getLanes(): Record<ProviderId, Lane> {
  if (!g.__wsu_lanes) {
    // Read config once on lane init. When the user saves Settings,
    // call setLaneConcurrency() to hot-update.
    let veoConc = DEFAULT_CONCURRENCY.veo;
    let grokConc = DEFAULT_CONCURRENCY.grok;
    try {
      const cfg = loadConfig();
      if (typeof cfg.VEO_CONCURRENCY === "number") veoConc = cfg.VEO_CONCURRENCY;
      if (typeof cfg.GROK_CONCURRENCY === "number") grokConc = cfg.GROK_CONCURRENCY;
    } catch {
      // ignore, fall back to defaults
    }
    g.__wsu_lanes = {
      veo: { concurrency: clamp(veoConc, 1, 10), active: 0, queue: [] },
      grok: { concurrency: clamp(grokConc, 1, 10), active: 0, queue: [] },
      local: { concurrency: DEFAULT_CONCURRENCY.local, active: 0, queue: [] },
    };
  }
  return g.__wsu_lanes;
}

function clamp(n: number, min: number, max: number): number {
  const v = Math.floor(n || min);
  return Math.max(min, Math.min(max, v));
}

/** Get the provider for a node kind. genMode disambiguates VEO vs Grok for gen.video. */
export function providerOf(kind: NodeKind, genMode?: string): ProviderId {
  if (genMode?.includes(".grok")) return "grok";
  if (genMode?.includes(".veo")) return "veo";
  const entry = NODE_CATALOG.find((e) => e.kind === kind);
  return entry?.provider || "local";
}

function drain(lane: Lane) {
  while (lane.active < lane.concurrency && lane.queue.length > 0) {
    const task = lane.queue.shift()!;
    lane.active++;
    task
      .run()
      .then((v) => task.resolve(v))
      .catch((e) => task.reject(e))
      .finally(() => {
        lane.active--;
        drain(lane);
      });
  }
}

export function runInLane<T>(provider: ProviderId, run: () => Promise<T>): Promise<T> {
  const lanes = getLanes();
  const lane = lanes[provider];
  return new Promise<T>((resolve, reject) => {
    lane.queue.push({
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    drain(lane);
  });
}

/** Update concurrency at runtime (called when Settings is saved). */
export function setLaneConcurrency(provider: ProviderId, concurrency: number) {
  const lanes = getLanes();
  const next = Math.max(1, Math.min(10, Math.floor(concurrency || 1)));
  lanes[provider].concurrency = next;
  drain(lanes[provider]);
}

export function getLaneStats(): Record<ProviderId, { concurrency: number; active: number; queued: number }> {
  const lanes = getLanes();
  return {
    veo: { concurrency: lanes.veo.concurrency, active: lanes.veo.active, queued: lanes.veo.queue.length },
    grok: { concurrency: lanes.grok.concurrency, active: lanes.grok.active, queued: lanes.grok.queue.length },
    local: { concurrency: lanes.local.concurrency, active: lanes.local.active, queued: lanes.local.queue.length },
  };
}
