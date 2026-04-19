import { NODE_CATALOG, type NodeKind, type ProviderId } from "@/lib/nodes";
import { loadConfig } from "./config";
import { readBatcherConfig } from "./providers/veo/batcher";

/**
 * Lane keys:
 *   - `veo`       — default VEO serialization (reCAPTCHA-gated, concurrency 1).
 *   - `veo-image` — separate sub-lane for `gen.image` when R2 batcher is on.
 *                   Concurrency up to `VEO_IMAGE_BATCH_MAX` so multiple callers
 *                   enter the batcher at once and get coalesced into one API
 *                   call. Falls back to shared with `veo` when batcher is off.
 *   - `grok`      — Grok Chrome session (concurrency 1).
 *   - `local`     — local transforms (unbounded).
 */
export type LaneKey = ProviderId | "veo-image";

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

const DEFAULT_CONCURRENCY: Record<LaneKey, number> = {
  veo: 1,
  "veo-image": 1,
  grok: 1,
  local: 8,
};

const g = globalThis as unknown as { __wsu_lanes?: Record<LaneKey, Lane> };

function getLanes(): Record<LaneKey, Lane> {
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
    // When R2 batcher is on, bump the `veo-image` sub-lane to the batch cap
    // so multiple gen.image nodes can enter the batcher at once.
    const batcher = readBatcherConfig();
    const veoImageConc = batcher.enabled ? batcher.maxBatchSize : veoConc;
    g.__wsu_lanes = {
      veo: { concurrency: clamp(veoConc, 1, 10), active: 0, queue: [] },
      "veo-image": { concurrency: clamp(veoImageConc, 1, 10), active: 0, queue: [] },
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

/**
 * Resolve the LaneKey for a node. `gen.image` routes to `veo-image` so it can
 * be parallelized under the batcher when `VEO_IMAGE_BATCH=1`; every other VEO
 * kind stays on `veo` to preserve single-flight reCAPTCHA semantics.
 */
export function laneKeyOf(kind: NodeKind, genMode?: string): LaneKey {
  const provider = providerOf(kind, genMode);
  if (provider !== "veo") return provider;
  if (kind === "gen.image") return "veo-image";
  return "veo";
}

/**
 * Drain a lane. Each task's outcome MUST decrement `lane.active` exactly once,
 * even if `task.resolve` / `task.reject` throw (they used to when the downstream
 * SSE listener threw during `setJobError`). We wrap settle in try/catch and
 * rely on a dedicated cleanup in `.finally`, which Promise semantics guarantee
 * runs regardless of handler failures.
 */
function drain(lane: Lane) {
  while (lane.active < lane.concurrency && lane.queue.length > 0) {
    const task = lane.queue.shift()!;
    lane.active++;
    let p: Promise<unknown>;
    try {
      p = task.run();
    } catch (err) {
      // run() threw synchronously before returning a Promise. Settle + clean up
      // inline so the lane doesn't leak an `active` count.
      try { task.reject(err); } catch { /* ignore listener errors */ }
      lane.active--;
      continue;
    }
    Promise.resolve(p)
      .then(
        (v) => {
          try { task.resolve(v); } catch { /* ignore listener errors */ }
        },
        (e) => {
          try { task.reject(e); } catch { /* ignore listener errors */ }
        },
      )
      .finally(() => {
        lane.active--;
        drain(lane);
      });
  }
}

export function runInLane<T>(laneKey: LaneKey, run: () => Promise<T>): Promise<T> {
  const lanes = getLanes();
  const lane = lanes[laneKey];
  return new Promise<T>((resolve, reject) => {
    lane.queue.push({
      run: run as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    drain(lane);
  });
}

/**
 * Drop every queued (not-yet-started) task from every lane and reject their
 * promises. Running tasks are left alone — they must abort via
 * `cancelAllActiveJobs()` + executor cancel-point checks. Returns the count of
 * queued tasks that were dropped.
 */
export function cancelQueuedTasks(): number {
  const lanes = getLanes();
  let dropped = 0;
  for (const key of Object.keys(lanes) as LaneKey[]) {
    const lane = lanes[key];
    while (lane.queue.length > 0) {
      const task = lane.queue.shift()!;
      try { task.reject(new Error("Cancelled")); } catch { /* ignore */ }
      dropped++;
    }
  }
  return dropped;
}

/**
 * Emergency reset for when lane.active has drifted (e.g. an old build crashed
 * mid-task before we hardened the settle path). Clears queued tasks AND zeroes
 * the active counter. Use with care — any still-running promise will complete
 * but its result is ignored by the lane.
 */
export function resetAllLanes(): { dropped: number; activeReset: Record<LaneKey, number> } {
  const lanes = getLanes();
  const activeReset = {} as Record<LaneKey, number>;
  const dropped = cancelQueuedTasks();
  for (const key of Object.keys(lanes) as LaneKey[]) {
    activeReset[key] = lanes[key].active;
    lanes[key].active = 0;
  }
  return { dropped, activeReset };
}

/** Update concurrency at runtime (called when Settings is saved). */
export function setLaneConcurrency(laneKey: LaneKey, concurrency: number) {
  const lanes = getLanes();
  const next = Math.max(1, Math.min(10, Math.floor(concurrency || 1)));
  lanes[laneKey].concurrency = next;
  drain(lanes[laneKey]);
}

export function getLaneStats(): Record<LaneKey, { concurrency: number; active: number; queued: number }> {
  const lanes = getLanes();
  return {
    veo: { concurrency: lanes.veo.concurrency, active: lanes.veo.active, queued: lanes.veo.queue.length },
    "veo-image": {
      concurrency: lanes["veo-image"].concurrency,
      active: lanes["veo-image"].active,
      queued: lanes["veo-image"].queue.length,
    },
    grok: { concurrency: lanes.grok.concurrency, active: lanes.grok.active, queued: lanes.grok.queue.length },
    local: { concurrency: lanes.local.concurrency, active: lanes.local.active, queued: lanes.local.queue.length },
  };
}
