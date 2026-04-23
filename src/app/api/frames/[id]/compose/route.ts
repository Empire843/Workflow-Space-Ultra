/**
 * POST /api/frames/[id]/compose
 *
 * Concatenate a sequence of generated clip videos into a single MP4 and drop
 * it in the workflow's `assets/outputs/` so the client can preview / download
 * it just like any other generated asset.
 *
 * Intended consumer: the "Export final video" button on a Frame node. The
 * client passes the child clip URLs in the order they appear left-to-right on
 * canvas — this route does no re-ordering.
 *
 * Request JSON:
 *   {
 *     workflowId: string,             // must be a valid workflow id
 *     videoUrls: string[],            // /api/workflows/<id>/assets/outputs/<file>.mp4 or
 *                                     // /api/files/<name> or absolute path inside BASE_DIR
 *     reencode?: boolean,             // force re-encode even if fast path is safe
 *   }
 *
 * Response JSON:
 *   {
 *     outputUrl: string,              // URL the client can put in an <video>
 *     outputPath: string,             // absolute disk path (for server-side usage)
 *     bytes: number,
 *     durationMs: number,             // wall-clock ffmpeg time
 *     fastPath: boolean,              // true if stream-copy concat was used
 *     totalDurationSec: number,       // sum of input durations (close to output duration)
 *   }
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  downloadedAssetUrl,
  resolveLocalMediaPath,
  sanitizeWorkflowId,
  workflowAssetPath,
  workflowAssetsDir,
} from "@/server/paths/workflowAssets";
import { concatVideos } from "@/server/util/ffmpeg";

const BodySchema = z.object({
  workflowId: z.string().min(1),
  videoUrls: z.array(z.string().min(1)).min(1).max(100),
  reencode: z.boolean().optional(),
});

export const runtime = "nodejs";
// Compose can take >60s for re-encode path; mark as dynamic so Next.js doesn't
// try to cache the route or impose an edge timeout.
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: frameId } = await ctx.params;
  if (!frameId || !/^[a-zA-Z0-9._-]{1,120}$/.test(frameId)) {
    return NextResponse.json({ error: "Invalid frame id" }, { status: 400 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body không hợp lệ: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "Body phải là JSON" }, { status: 400 });
  }

  const workflowId = sanitizeWorkflowId(body.workflowId);
  if (!workflowId) {
    return NextResponse.json({ error: "workflowId không hợp lệ" }, { status: 400 });
  }

  // Resolve every input URL to an absolute filesystem path INSIDE the
  // workflow's own asset tree. `resolveLocalMediaPath` already rejects remote
  // URLs / data URIs / escape attempts, but it also allows paths anywhere in
  // BASE_DIR — we tighten that to "must be inside this workflow's outputs/"
  // so a compose on workflow A can't read outputs from workflow B.
  const workflowAssetRoot = workflowAssetsDir(workflowId);
  const inputPaths: string[] = [];
  for (const url of body.videoUrls) {
    const resolved = resolveLocalMediaPath(url);
    if (!resolved) {
      return NextResponse.json(
        { error: `Không resolve được URL thành file local: ${url}` },
        { status: 400 },
      );
    }
    const rootWithSep = workflowAssetRoot.endsWith(path.sep)
      ? workflowAssetRoot
      : workflowAssetRoot + path.sep;
    if (resolved !== workflowAssetRoot && !resolved.startsWith(rootWithSep)) {
      return NextResponse.json(
        { error: `File không nằm trong workflow ${workflowId}: ${url}` },
        { status: 400 },
      );
    }
    if (!existsSync(resolved)) {
      return NextResponse.json(
        { error: `File không tồn tại: ${resolved}` },
        { status: 404 },
      );
    }
    inputPaths.push(resolved);
  }

  // Output: Workflows/<id>/assets/outputs/frame-<frameId>-final-<ts>.mp4
  // `outputs` is created by `resolveDownloadDir` the first time a real asset
  // is generated; we recreate here in case a fresh workflow hasn't had any
  // run yet but a user imported clips manually.
  const outputsDir = workflowAssetPath(workflowId, "outputs");
  if (!outputsDir) {
    return NextResponse.json({ error: "Không resolve được outputs/ dir" }, { status: 500 });
  }
  if (!existsSync(outputsDir)) mkdirSync(outputsDir, { recursive: true });

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/T/, "_")
    .replace(/Z$/, "");
  const outputName = `frame-${frameId}-final-${stamp}.mp4`;
  const outputPath = path.join(outputsDir, outputName);

  const started = Date.now();
  try {
    const { fastPath, probes } = await concatVideos(inputPaths, outputPath, {
      reencode: body.reencode,
    });
    const durationMs = Date.now() - started;
    const stat = statSync(outputPath);
    const totalDurationSec = probes.reduce((s, p) => s + (p.durationSec || 0), 0);

    return NextResponse.json({
      outputUrl: downloadedAssetUrl(workflowId, outputPath),
      outputPath,
      bytes: stat.size,
      durationMs,
      fastPath,
      totalDurationSec,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[frames/compose]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
