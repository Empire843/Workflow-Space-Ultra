import { NextResponse } from "next/server";

import type { NodeDataBase, NodeKind } from "@/lib/nodes";
import { executeNode } from "@/server/executor";
import { providerOf, runInLane } from "@/server/lanes";
import { createJob, setJobError } from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EnqueueBody {
  nodeId: string;
  kind: NodeKind;
  data: NodeDataBase;
  inputs?: NodeDataBase[];
  workflowRunId?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as EnqueueBody;
  if (!body?.nodeId || !body.kind || !body.data) {
    return NextResponse.json({ ok: false, message: "Missing fields" }, { status: 400 });
  }

  const job = createJob({
    nodeId: body.nodeId,
    kind: body.kind,
    workflowRunId: body.workflowRunId,
  });

  // Via lane: if the provider has no free slots, the job stays "queued" until a slot opens.
  setTimeout(() => {
    const provider = providerOf(body.kind, body.data.genMode);
    runInLane(provider, () => executeNode(job, body.data, body.inputs || [])).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      setJobError(job.id, msg);
    });
  }, 0);

  return NextResponse.json({ ok: true, jobId: job.id });
}
