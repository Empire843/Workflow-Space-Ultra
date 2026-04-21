import { NextResponse } from "next/server";

import { cancelJobById, getJobById } from "@/server/actions/handlers";
import { gate } from "@/server/actions/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  const { id } = await params;
  const job = getJobById(id);
  if (!job) {
    return NextResponse.json(
      { error: "not_found", error_description: `no job with id ${id}` },
      { status: 404 },
    );
  }
  return NextResponse.json({ job });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  const { id } = await params;
  const outcome = cancelJobById(id);
  if (!outcome.cancelled) {
    return NextResponse.json(
      { error: "not_found", error_description: outcome.reason ?? "no such job" },
      { status: 404 },
    );
  }
  return NextResponse.json(outcome);
}
