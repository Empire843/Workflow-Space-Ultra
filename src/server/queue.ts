import { EventEmitter } from "node:events";

import type { NodeDataBase, NodeKind } from "@/lib/nodes";

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
  updateJob(id, { status: "error", error, finishedAt: Date.now() });
  emit({ type: "error", jobId: id, error, timestamp: Date.now() });
}

export function requestCancel(id: string) {
  updateJob(id, { cancelRequested: true });
  emit({ type: "log", jobId: id, log: "Cancel requested", timestamp: Date.now() });
}

export function getJob(id: string): JobRecord | null {
  return getState().jobs.get(id) || null;
}

export function emit(ev: JobEvent) {
  getState().emitter.emit("event", ev);
  getState().emitter.emit(`job:${ev.jobId}`, ev);
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
