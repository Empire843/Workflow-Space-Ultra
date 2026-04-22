import { runGenVideoStartEnd } from "@/server/actions/handlers";
import { gate, parseWithShape, readJsonBody, runSafe } from "@/server/actions/routeHelpers";
import { VideoStartEndShape } from "@/server/mcp/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  const body = await readJsonBody(req);
  const parsed = parseWithShape(VideoStartEndShape, body);
  if (!parsed.ok) return parsed.error;
  return runSafe(() => runGenVideoStartEnd(parsed.data));
}
