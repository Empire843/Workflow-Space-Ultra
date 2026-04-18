import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { DOWNLOADS_DIR } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const safe = path.basename(name);
  const abs = path.join(DOWNLOADS_DIR, safe);
  try {
    const s = await stat(abs);
    if (!s.isFile()) return new Response("Not found", { status: 404 });
    const ext = path.extname(safe).toLowerCase();
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
