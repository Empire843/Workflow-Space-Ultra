import { NextResponse } from "next/server";

import { readAuthStatus } from "@/server/actions/handlers";
import { gate } from "@/server/actions/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  return NextResponse.json(readAuthStatus());
}
