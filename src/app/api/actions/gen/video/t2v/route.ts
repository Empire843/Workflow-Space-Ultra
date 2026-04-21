import { runGenVideoT2V } from "@/server/actions/handlers";
import { gate, parseWithShape, readJsonBody, runSafe } from "@/server/actions/routeHelpers";
import { VideoT2VShape } from "@/server/mcp/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const g = gate(req);
  if (!g.ok) return g.response;
  const body = await readJsonBody(req);
  const parsed = parseWithShape(VideoT2VShape, body);
  if (!parsed.ok) return parsed.error;
  return runSafe(() => runGenVideoT2V(parsed.data));
}
