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
  return rec;
}

export function setJobProgress(id: string, progress: number) {
  updateJob(id, { progress });
  emit({ type: "progress", jobId: id, progress, timestamp: Date.now() });
}

export function setJobLog(id: string, log: string) {
  emit({ type: "log", jobId: id, log, timestamp: Date.now() });
}

export function setJobOutput(id: string, output: NodeDataBase) {
  updateJob(id, { output });
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

export function requestCancel(id: string) {
  updateJob(id, { cancelRequested: true });
  emit({ type: "log", jobId: id, log: "Cancel requested", timestamp: Date.now() });
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
