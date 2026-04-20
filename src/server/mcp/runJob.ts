import type { GenMode, NodeDataBase, NodeKind } from "@/lib/nodes";
import { executeNode, JobCancelledError } from "@/server/executor";
import { laneKeyOf, runInLane } from "@/server/lanes";
import {
  createJob,
  getJob,
  setJobError,
  subscribeJob,
  type JobEvent,
  type JobRecord,
} from "@/server/queue";

/**
 * Glue between an MCP tool call and the existing executor + queue + lane
 * plumbing. Mirrors the behavior of the REST route in
 * `/api/jobs/route.ts` (createJob → runInLane → executeNode) but returns a
 * promise that resolves with the final output so the tool handler can reply
 * synchronously.
 *
 * Progress + status notifications are forwarded via `onEvent` — MCP tool
 * callers plug this into `server.sendLoggingMessage` or the client-supplied
 * `_meta.progressToken` so the host sees live tool execution feedback.
 */
export interface RunMcpJobInput {
  nodeId: string;
  kind: NodeKind;
  data: NodeDataBase;
  inputs?: NodeDataBase[];
  workflowId?: string;
  onEvent?: (event: JobEvent) => void;
}

export interface RunMcpJobResult {
  job: JobRecord;
  output: NodeDataBase;
}

export async function runMcpJob(input: RunMcpJobInput): Promise<RunMcpJobResult> {
  const job = createJob({
    nodeId: input.nodeId,
    kind: input.kind,
    workflowRunId: input.workflowId,
  });

  const unsubscribe = input.onEvent ? subscribeJob(job.id, input.onEvent) : null;

  try {
    const lane = laneKeyOf(input.kind, (input.data as { genMode?: GenMode }).genMode);
    const output = await runInLane(lane, () =>
      executeNode(job, input.data, input.inputs ?? []),
    );
    return { job: getJob(job.id) ?? job, output };
  } catch (err) {
    if (err instanceof JobCancelledError) {
      // Executor already transitioned the job to `cancelled`; re-throw so the
      // tool handler can translate into an MCP error.
      throw err;
    }
    // For any non-cancel failure, make sure the queue has the error recorded
    // (it usually is — the executor calls setJobError before throwing —
    // but defensive: a handler that throws before entering the executor
    // wouldn't).
    const current = getJob(job.id);
    if (current && current.status !== "error") {
      setJobError(job.id, err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    unsubscribe?.();
  }
}
