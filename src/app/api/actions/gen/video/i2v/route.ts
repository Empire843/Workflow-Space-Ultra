import { runGenVideoI2V } from "@/server/actions/handlers";
import { gate, parseWithShape, readJsonBody, runSafe } from "@/server/actions/routeHelpers";
import { VideoI2VShape } from "@/server/mcp/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  const body = await readJsonBody(req);
  const parsed = parseWithShape(VideoI2VShape, body);
  if (!parsed.ok) return parsed.error;
  return runSafe(() => runGenVideoI2V(parsed.data));
}
