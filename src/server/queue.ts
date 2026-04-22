import { EventEmitter } from "node:events";

import type { NodeDataBase, NodeKind } from "@/lib/nodes";

import { logError } from "./telemetry/errorLog";

/**
 * In-memory job queue + event bus for SSE.
 * Scope: the Next.js dev/prod server process. For Next dev, keep a singleton via globalThis.
 */

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface JobInput {
  kind: NodeKind;
  data: NodeDataBase;
  inputs?: Record<string, NodeDataBase | undefined>;
}

export interface JobRecord {
  id: string;
  workflowRunId?: string;
  nodeId: string;
  kind: NodeKind;
  status: JobStatus;
  progress: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  output?: NodeDataBase;
  error?: string;
  cancelRequested?: boolean;
}

export interface JobEvent {
  type: "status" | "progress" | "output" | "error" | "log";
  jobId: string;
  status?: JobStatus;
  progress?: number;
  output?: NodeDataBase;
  error?: string;
  log?: string;
  timestamp: number;
}

interface QueueState {
  jobs: Map<string, JobRecord>;
  emitter: EventEmitter;
}

const g = globalThis as unknown as { __wsu_queue?: QueueState };

function getState(): QueueState {
  if (!g.__wsu_queue) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(200);
    g.__wsu_queue = { jobs: new Map(), emitter };
  }
  return g.__wsu_queue;
}

export function createJob(input: { nodeId: string; kind: NodeKind; workflowRunId?: string }): JobRecord {
  const state = getState();
  const id = `job_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const rec: JobRecord = {
    id,
    workflowRunId: input.workflowRunId,
    nodeId: input.nodeId,
    kind: input.kind,
    status: "queued",
    progress: 0,
    createdAt: Date.now(),
  };
  state.jobs.set(id, rec);
  emit({ type: "status", jobId: id, status: "queued", timestamp: Date.now() });
  return rec;
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord | null {
  const state = getState();
  const rec = state.jobs.get(id);
  if (!rec) return null;
  Object.assign(rec, patch);
  state.jobs.set(id, rec);
  return rec;
}

export function setJobStatus(id: string, status: JobStatus, extras?: Partial<JobRecord>) {
  const rec = updateJob(id, { status, ...extras, ...(status === "running" && !extras?.startedAt ? { startedAt: Date.now() } : {}), ...(status === "done" || status === "error" || status === "cancelled" ? { finishedAt: Date.now() } : {}) });
  if (rec) emit({ type: "status", jobId: id, status, timestamp: Date.now() });
  // Stuck-watchdog lifecycle lives with the status transition: arm on
  // entry to `running`, disarm on any terminal state. Any progress / log
  // emit while running re-arms the timers via `markJobActivity`.
  if (status === "running") {
    armStuckWatchdog(id);
  } else if (status === "done" || status === "error" || status === "cancelled") {
    disarmStuckWatchdog(id);
  }
  return rec;
}

export function setJobProgress(id: string, progress: number) {
  updateJob(id, { progress });
  markJobActivity(id);
  emit({ type: "progress", jobId: id, progress, timestamp: Date.now() });
}

export function setJobLog(id: string, log: string) {
  markJobActivity(id);
  emit({ type: "log", jobId: id, log, timestamp: Date.now() });
}

export function setJobOutput(id: string, output: NodeDataBase) {
  updateJob(id, { output });
  markJobActivity(id);
  emit({ type: "output", jobId: id, output, timestamp: Date.now() });
}

export function setJobError(id: string, error: string) {
  const job = getState().jobs.get(id);
  updateJob(id, { status: "error", error, finishedAt: Date.now() });
  emit({ type: "error", jobId: id, error, timestamp: Date.now() });
  // Dedicated error log: every job-level error flows through here, so this
  // is the single hook that guarantees nothing slips through. Extra fields
  // tie the error back to the specific node + run on disk.
  logError({
    context: "job.error",
    error,
    extra: {
      jobId: id,
      nodeId: job?.nodeId,
      kind: job?.kind,
      workflowRunId: job?.workflowRunId,
      startedAt: job?.startedAt,
      durationMs: job?.startedAt ? Date.now() - job.startedAt : undefined,
    },
  });
}

/**
 * Stuck-job watchdog — picks up the other half of the responsiveness
 * story that `requestCancel`'s watchdog doesn't cover. Where the
 * cancel-watchdog only fires when the user explicitly asked us to
 * abort, this one fires *without* user intent, when a job has been
 * running but completely silent (no log / progress / output emit) for
 * long enough that it's almost certainly stuck.
 *
 * Two thresholds:
 *   - `STUCK_WARN_MS` — post an advisory log explaining the most likely
 *     causes (Chrome VEO minimized, OAuth expired, etc.). Non-fatal.
 *   - `STUCK_FAIL_MS` — force the job into `error` state with an
 *     actionable message so the UI stops lying about "running · 1%"
 *     indefinitely. The underlying Playwright op keeps running in the
 *     background; lane.active will eventually settle when it resolves.
 *
 * These numbers are tuned against the worst legitimate slow path:
 *   - `buildBaseAuth` at 60s (collectAuth default timeout)
 *   - `getFreshRecaptchaToken` at 40s (first-use budget)
 *   - `postJsonViaBrowser` at 60s
 *   → ~160s end-to-end on a legit retry cycle. Warn at 120s gives the
 *   user early feedback without being overly noisy; fail at 300s is
 *   well past any realistic legit wait.
 */
const STUCK_WARN_MS = 120_000;
const STUCK_FAIL_MS = 300_000;

interface StuckWatchers {
  warn: ReturnType<typeof setTimeout>;
  fail: ReturnType<typeof setTimeout>;
}
const stuckWatchers = new Map<string, StuckWatchers>();

function armStuckWatchdog(id: string): void {
  disarmStuckWatchdog(id);
  const warn = setTimeout(() => {
    const job = getJob(id);
    if (!job || job.status !== "running") return;
    // Advisory only — do not throw / cancel. Give the user enough detail
    // to diagnose without terminating a possibly-healthy-but-slow job.
    emit({
      type: "log",
      jobId: id,
      log:
        `⚠ Job chạy ${STUCK_WARN_MS / 1000}s không có tiến độ mới. Các nguyên nhân thường gặp:\n` +
        `  1) Cửa sổ Chrome VEO đang bị minimize / tab VEO ở nền → Chrome throttle grecaptcha.\n` +
        `  2) OAuth token đã hết hạn + tab Flow bị navigate sang trang login (badge "REFRESH SOON" ở topbar).\n` +
        `  3) Một capture recaptcha khác đang tắc, các job khác xếp hàng đợi.\n` +
        `→ Mở cửa sổ Chrome VEO, đưa nó lên foreground, đảm bảo đang ở 1 project labs.google/fx. ` +
        `Nếu sau ${(STUCK_FAIL_MS - STUCK_WARN_MS) / 1000}s nữa vẫn không tiến triển, job sẽ tự fail.`,
      timestamp: Date.now(),
    });
  }, STUCK_WARN_MS);
  const fail = setTimeout(() => {
    const job = getJob(id);
    if (!job || job.status !== "running") return;
    const msg =
      `Stuck detected: không có tiến độ nào sau ${STUCK_FAIL_MS / 1000}s. ` +
      `Thường do Chrome VEO bị minimize/background hoặc session Google đã hết hạn. ` +
      `Hãy mở lại cửa sổ Chrome VEO (foreground), xác nhận đang ở project labs.google/fx, ` +
      `rồi retry node. Nếu vẫn lặp lại, dùng "Force reset lanes" ở Queue panel.`;
    setJobError(id, msg);
  }, STUCK_FAIL_MS);
  stuckWatchers.set(id, { warn, fail });
}

function disarmStuckWatchdog(id: string): void {
  const w = stuckWatchers.get(id);
  if (!w) return;
  clearTimeout(w.warn);
  clearTimeout(w.fail);
  stuckWatchers.delete(id);
}

/**
 * Re-arm the stuck watchdog. Called from `setJobLog`, `setJobProgress`,
 * `setJobOutput` — any "real work is happening" signal resets the
 * timers. Explicitly NOT called from `requestCancel` / watchdog
 * logs / `cancelAllActiveJobs`, which would let a stuck job dodge the
 * fail threshold forever by piling on cancel-related noise.
 */
function markJobActivity(id: string): void {
  const j = getJob(id);
  if (!j || j.status !== "running") return;
  armStuckWatchdog(id);
}

/**
 * Hard-cancel hook registry — providers (currently just VEO) register
 * invalidation callbacks here. When the soft-cancel watchdog trips we
 * call these to drop any Playwright page handles that might be pinning
 * a job's stack. Keeps queue.ts free of direct Playwright imports and
 * avoids circular deps with `providers/**`.
 */
type HardCancelHook = (jobId: string) => void | Promise<void>;
const hardCancelHooks: HardCancelHook[] = [];
export function registerHardCancelHook(fn: HardCancelHook): () => void {
  hardCancelHooks.push(fn);
  return () => {
    const idx = hardCancelHooks.indexOf(fn);
    if (idx >= 0) hardCancelHooks.splice(idx, 1);
  };
}

/**
 * How long we let soft cancellation (the `cancelRequested` flag + the
 * provider-level `raceCancel` polling) try to unwind a running job
 * before we escalate. Picked so that the common 200ms cancel-point
 * propagation has plenty of headroom but a genuinely stuck Playwright
 * await can't sit in "cancelling…" indefinitely.
 */
const HARD_CANCEL_WATCHDOG_MS = 10_000;
/**
 * Additional grace after we invoke hard-cancel hooks before we force
 * the UI to "cancelled". Hooks typically drop a page handle which
 * causes Playwright to throw "Target closed" on the current await —
 * that then needs ~1-2s to unwind through the stack.
 */
const HARD_CANCEL_GRACE_MS = 3_000;

export function requestCancel(id: string) {
  updateJob(id, { cancelRequested: true });
  emit({ type: "log", jobId: id, log: "Cancel requested", timestamp: Date.now() });

  // Soft cancel first: providers poll `cancelRequested` at their
  // cancel-points and unwind naturally (fast path, ~200ms). The
  // watchdog below is the safety net for cases where some await is
  // deep inside Playwright / fetch and can't be interrupted cleanly.
  setTimeout(() => {
    const job = getJob(id);
    if (!job) return;
    if (job.status !== "running") return;

    emit({
      type: "log",
      jobId: id,
      log: `Cancel watchdog: soft cancel timed out sau ${HARD_CANCEL_WATCHDOG_MS / 1000}s — đang ép hủy tab VEO.`,
      timestamp: Date.now(),
    });

    // Fire hard-cancel hooks concurrently; they're best-effort and
    // must never throw back up. Typical behaviour: close/invalidate
    // the VEO Playwright page, which causes any pending awaits on it
    // to reject with "Target closed".
    for (const hook of hardCancelHooks) {
      try {
        const result = hook(id);
        if (result && typeof (result as Promise<unknown>).catch === "function") {
          (result as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // ignore — hooks must not block cancellation
      }
    }

    // Final enforcement: if the job is STILL running after hooks had a
    // moment to propagate, force-transition to cancelled so the UI
    // doesn't lie to the user. The underlying Playwright op may keep
    // running in the background (lane.active stays busy until it
    // resolves) but the user-facing state is correct and a new job
    // can be queued.
    setTimeout(() => {
      const j2 = getJob(id);
      if (!j2) return;
      if (j2.status !== "running") return;
      emit({
        type: "log",
        jobId: id,
        log: "Cancel watchdog: ép trạng thái về cancelled (op nền sẽ tự kết thúc).",
        timestamp: Date.now(),
      });
      setJobStatus(id, "cancelled", { error: "Cancelled (forced after timeout)" });
    }, HARD_CANCEL_GRACE_MS);
  }, HARD_CANCEL_WATCHDOG_MS);
}

export function getJob(id: string): JobRecord | null {
  return getState().jobs.get(id) || null;
}

/**
 * Return every job currently tracked by the queue, newest first.
 * Used by `GET /api/queue` to power the client-side Queue panel.
 */
export function listJobs(): JobRecord[] {
  const state = getState();
  return Array.from(state.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Drop jobs that are in a terminal state (done / error / cancelled).
 * Emits a "log" event so any open SSE stream sees a clean shutdown.
 */
export function clearFinishedJobs(): number {
  const state = getState();
  let removed = 0;
  for (const [id, rec] of state.jobs) {
    if (rec.status === "done" || rec.status === "error" || rec.status === "cancelled") {
      state.jobs.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Mark every non-terminal job as cancel-requested. The executor checks this
 * flag at key points and aborts. Also emits a "cancelled" status for jobs that
 * are still "queued" (never entered a lane) so the client can clean up.
 */
export function cancelAllActiveJobs(): number {
  const state = getState();
  let cancelled = 0;
  for (const rec of state.jobs.values()) {
    if (rec.status === "queued" || rec.status === "running") {
      rec.cancelRequested = true;
      if (rec.status === "queued") {
        setJobStatus(rec.id, "cancelled", { error: "Cancelled by user" });
      } else {
        emit({ type: "log", jobId: rec.id, log: "Cancel requested", timestamp: Date.now() });
      }
      cancelled++;
    }
  }
  return cancelled;
}

/**
 * emit() forwards an event to both the global stream and the per-job
 * subscribers. A single buggy listener must NOT break the others, so every
 * handler runs inside its own try/catch. Previously a closed SSE controller
 * threw synchronously here, skipping later listeners and bubbling up to the
 * caller — which then crashed the lane's `.finally` cleanup and left `active`
 * stuck. Now listener failures are swallowed (logged once to aid debugging).
 */
export function emit(ev: JobEvent) {
  const state = getState();
  const broadcast = (event: string) => {
    const listeners = state.emitter.listeners(event);
    for (const listener of listeners) {
      try {
        (listener as (e: JobEvent) => void)(ev);
      } catch (err) {
        if (typeof process !== "undefined" && process.env.NODE_ENV !== "production") {
          console.error("[queue] listener error on", event, err);
        }
        // Record listener failures too — otherwise a broken subscriber can
        // silently drop events forever and only show up as ghost jobs.
        logError({
          context: "queue.listener",
          error: err,
          extra: { event, jobId: ev.jobId, type: ev.type },
        });
      }
    }
  };
  broadcast("event");
  broadcast(`job:${ev.jobId}`);
}

export function subscribe(handler: (ev: JobEvent) => void): () => void {
  const state = getState();
  state.emitter.on("event", handler);
  return () => state.emitter.off("event", handler);
}

export function subscribeJob(jobId: string, handler: (ev: JobEvent) => void): () => void {
  const state = getState();
  state.emitter.on(`job:${jobId}`, handler);
  return () => state.emitter.off(`job:${jobId}`, handler);
}
