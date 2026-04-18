import { NextResponse } from "next/server";

import type { NodeDataBase } from "@/lib/nodes";
import { EnqueueJobSchema } from "@/lib/schemas/api";
import { executeNode } from "@/server/executor";
import { parseJsonBody } from "@/server/http/validate";
import { providerOf, runInLane } from "@/server/lanes";
import { createJob, setJobError } from "@/server/queue";

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
    const provider = providerOf(body.kind, nodeData.genMode);
    runInLane(provider, () => executeNode(job, nodeData, inputs)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setJobError(job.id, msg);
    });
  }, 0);

  return NextResponse.json({ ok: true, jobId: job.id });
}
