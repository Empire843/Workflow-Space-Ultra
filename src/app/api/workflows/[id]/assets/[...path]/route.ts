import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { workflowAssetPath } from "@/server/paths/workflowAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path: segments } = await ctx.params;
  
  const abs = workflowAssetPath(id, ...segments);
  if (!abs) return new Response("Not found", { status: 404 });

  try {
    const s = await stat(abs);
    if (!s.isFile()) return new Response("Not found", { status: 404 });

    const ext = path.extname(abs).toLowerCase();
    const mime =
      ext === ".mp4"
        ? "video/mp4"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".png"
            ? "image/png"
            : ext === ".jpg" || ext === ".jpeg"
              ? "image/jpeg"
              : "application/octet-stream";

    const stream = createReadStream(abs);
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(s.size),
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
