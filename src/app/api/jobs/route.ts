import { NextResponse } from "next/server";

import type { NodeDataBase } from "@/lib/nodes";
import { EnqueueJobSchema } from "@/lib/schemas/api";
import { executeNode, JobCancelledError } from "@/server/executor";
import { parseJsonBody } from "@/server/http/validate";
import { laneKeyOf, runInLane } from "@/server/lanes";
import { createJob, getJob, setJobError, setJobStatus } from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const result = await parseJsonBody(req, EnqueueJobSchema);
  if ("response" in result) return result.response;
  const body = result.data;
  const nodeData = body.data as NodeDataBase;
  const inputs = (body.inputs ?? []) as NodeDataBase[];

  const job = createJob({
    nodeId: body.nodeId,
    kind: body.kind,
    workflowRunId: body.workflowRunId,
  });

  // Via lane: if the provider has no free slots, the job stays "queued" until a slot opens.
  setTimeout(() => {
    // Check if the user already cancelled the job while it was still queued
    // (e.g. they hit "Cancel all" before the lane drained it).
    const current = getJob(job.id);
    if (current?.cancelRequested || current?.status === "cancelled") {
      if (current.status !== "cancelled") setJobStatus(job.id, "cancelled", { error: "Cancelled" });
      return;
    }
    const lane = laneKeyOf(body.kind, nodeData.genMode);
    runInLane(lane, () => executeNode(job, nodeData, inputs)).catch((err) => {
      if (err instanceof JobCancelledError) {
        // executor already set status=cancelled; nothing to do.
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setJobError(job.id, msg);
    });
  }, 0);

  return NextResponse.json({ ok: true, jobId: job.id });
}
