import type { GenMode, NodeDataBase, NodeKind, OutputItem } from "@/lib/nodes";
import { buildCombinedPrompt, joinTextSegments } from "@/lib/prompt";
import { resolveI2vModelKey, resolveT2vModelKey } from "@/lib/veoVideoModels";

import { JobCancelledError, type ShouldCancel } from "./providers/cancellation";
import {
  grokDownloadVideo,
  grokI2V,
  grokT2V,
  grokUpload,
} from "./providers/grok";
import { GROK_ASSETS_BASE } from "./providers/grok/constants";
import {
  CREATE_IMAGE_MODEL_TO_KEY,
  MODEL_SUPPORTS_REFERENCE,
  veoCreateImage,
  veoDownload,
  veoImageToVideo,
  veoTextToVideo,
  veoUploadImage,
  veoWaitForVideos,
} from "./providers/veo";
import {
  getJob,
  setJobError,
  setJobLog,
  setJobOutput,
  setJobProgress,
  setJobStatus,
  type JobRecord,
} from "./queue";
import {
  downloadedAssetUrl,
  resolveLocalMediaPath,
  writeBase64Asset,
} from "./paths/workflowAssets";
import { logError } from "./telemetry/errorLog";
import { timedSpan } from "./telemetry/timing";
import { pMapLimited } from "./util/pMap";

/**
 * Re-export so existing API routes (`/api/jobs/route.ts`) keep their
 * `import { JobCancelledError } from "@/server/executor"` path working.
 * Actual class + cancel helpers live in `./providers/cancellation` so
 * provider-side code can import them without creating a cycle back into
 * the executor/queue layer.
 */
export { JobCancelledError } from "./providers/cancellation";

/**
 * Throw a `JobCancelledError` if the user requested cancellation since the last
 * check. Called at the top of every long-running branch (image gen, video
 * poll, download) so the executor stops at the next safe point.
 */
function assertNotCancelled(jobId: string): void {
  const rec = getJob(jobId);
  if (rec?.cancelRequested) throw new JobCancelledError();
}

/**
 * Build a `ShouldCancel` closure that the VEO/Grok provider layer can
 * poll from inside its own loops. Reads the live queue record every
 * call so new cancel requests are seen the moment they're flipped.
 */
function makeShouldCancel(jobId: string): ShouldCancel {
  return () => Boolean(getJob(jobId)?.cancelRequested);
}

/**
 * Execute a single node. Upstream outputs are already available in `inputs`.
 * Returns a new NodeDataBase (status=done, imageUrl/videoUrl ...).
 */

export async function executeNode(
  job: JobRecord,
  nodeData: NodeDataBase,
  inputs: NodeDataBase[]
): Promise<NodeDataBase> {
  const log = (msg: string) => setJobLog(job.id, msg);
  return timedSpan(
    `executor.${nodeData.kind}`,
    () => _executeNode(job, nodeData, inputs),
    log
  );
}

async function _executeNode(
  job: JobRecord,
  nodeData: NodeDataBase,
  inputs: NodeDataBase[]
): Promise<NodeDataBase> {
  assertNotCancelled(job.id);
  setJobStatus(job.id, "running");
  setJobProgress(job.id, 1);

  try {
    const kind = nodeData.kind;

    // Content nodes just pass through their own data.
    // Text nodes are special: if there is upstream content.text → concat to produce effectiveText
    // (keep `text` as the raw user input, only add `effectiveText` for downstream consumers).
    if (isContent(kind)) {
      if (kind === "content.text") {
        const upstream = inputs
          .filter((i) => i?.kind === "content.text")
          .map((i) => i.effectiveText || i.text || "");
        const combined = joinTextSegments([...upstream, nodeData.text]);
        const out: NodeDataBase = {
          ...nodeData,
          effectiveText: combined,
          status: "done",
          progress: 100,
        };
        setJobOutput(job.id, out);
        setJobStatus(job.id, "done");
        return out;
      }
      const out: NodeDataBase = { ...nodeData, status: "done", progress: 100 };
      setJobOutput(job.id, out);
      setJobStatus(job.id, "done");
      return out;
    }

    // Prompt = all upstream text (in edge order) + own prompt. The helper lives
    // in @/lib/prompt so client preview and server execution agree on the
    // join semantics. IMPORTANT: do NOT mutate `nodeData.prompt` with the
    // combined text — the client merges `msg.output` back into node.data after
    // run → overwriting prompt with upstream+own would double the upstream on
    // subsequent re-runs. Use a local `genData` for providers only.
    const combinedPrompt = buildCombinedPrompt(nodeData.prompt, inputs);
    const genData: NodeDataBase = { ...nodeData, prompt: combinedPrompt };

    // Resolve all upstream image inputs (edge order). Indices 0 / 1 map to
    // start / end frames for Start+End pipelines; extras are ignored.
    const imageInputs = inputs.filter(
      (i) => i && (i.imageMediaId || i.uploadBase64 || i.imageUrl)
    );
    const primary = imageInputs[0];
    const secondary = imageInputs[1];
    const extraImages = Math.max(0, imageInputs.length - 2);

    let output: NodeDataBase = { ...nodeData };

    // Helper log: emit log event and print to console for server-side monitoring
    // IMPORTANT: Use console.error so we don't corrupt the MCP stdio JSON-RPC stream.
    const log = (msg: string) => {
      console.error(`[job:${job.id}] ${msg}`);
      setJobLog(job.id, msg);
    };

    const genMode = nodeData.genMode;

    if (kind === "gen.image") {
      // Collect every upstream image (not just primary) — Nano Banana can take
      // multiple references. For Imagen or other T2I-only models, the
      // createImage payload silently drops these.
      const allRefs = inputs.filter(
        (i) => i && (i.imageMediaId || i.uploadBase64 || i.imageUrl)
      );
      if (allRefs.length) {
        log(`Phát hiện ${allRefs.length} ảnh upstream → dùng làm reference cho Nano Banana…`);
      } else {
        log("Bắt đầu tạo ảnh VEO…");
      }
      const items = await runVeoCreateImage(job, genData, allRefs, log);
      assignOutputItems(output, items, "image");
      setJobProgress(job.id, 100);
    } else if (kind === "gen.video") {
      // T2V and I2V collapsed into one node kind — the executor picks the
      // pipeline on the fly: connect 0 images → T2V, 1 → I2V (start frame),
      // 2 → VEO Start+End. The legacy `i2v.*` modes route to the matching
      // `t2v.*` branch below so un-migrated workflows keep running.
      const warnExtras = () => {
        if (extraImages > 0) {
          log(`Lưu ý: có ${imageInputs.length} ảnh upstream, chỉ dùng 2 ảnh đầu (bỏ qua ${extraImages} ảnh cuối).`);
        }
      };
      const effectiveMode: GenMode =
        genMode === "i2v.veo"
          ? "t2v.veo"
          : genMode === "i2v.grok"
            ? "t2v.grok"
            : (genMode as GenMode) || "t2v.veo";

      if (effectiveMode === "t2v.grok") {
        if (primary) {
          log("Phát hiện ảnh upstream → dùng Grok I2V…");
          if (secondary) log("Grok I2V chỉ hỗ trợ 1 ảnh — dùng ảnh đầu, bỏ qua ảnh thứ 2.");
          warnExtras();
        } else {
          log("Bắt đầu tạo video Grok…");
        }
        const items = primary
          ? await runGrokI2V(job, genData, primary, log)
          : await runGrokT2V(job, genData, log);
        assignOutputItems(output, items, "video");
      } else {
        if (primary && secondary) {
          log("Phát hiện 2 ảnh upstream → auto-route sang VEO Start+End (ảnh 1 = start frame, ảnh 2 = end frame)…");
          warnExtras();
        } else if (primary) {
          log("Phát hiện ảnh upstream → dùng I2V API (ảnh = start frame)…");
        } else {
          log("Bắt đầu tạo video VEO (text-to-video)…");
        }
        const items = primary
          ? await runVeoI2V(job, genData, primary, secondary, log)
          : await runVeoT2V(job, genData, log);
        assignOutputItems(output, items, "video");
      }
      setJobProgress(job.id, 100);
    } else if (kind === "gen.start-end") {
      if (!primary) throw new Error("Cần Image upstream cho start frame");
      if (!secondary) throw new Error("Start+End cần 2 upstream image (start + end)");
      log("Bắt đầu tạo video VEO (start+end frame)…");
      const items = await runVeoI2V(job, genData, primary, secondary, log);
      assignOutputItems(output, items, "video");
      setJobProgress(job.id, 100);
    } else if (kind === "xform.upscale.grok") {
      throw new Error("Upscale node cần hookup với Grok videoId (chưa MVP)");
    } else if (kind === "xform.enhance" || kind === "xform.remove-bg") {
      throw new Error("Transformation node local chưa implement (MVP placeholder)");
    } else if (kind === "xform.extract-frames") {
      throw new Error("Extract Frames chạy client-side (dùng node Upload để nạp lại ảnh).");
    } else if (kind === "content.clone") {
      log("Bắt đầu tải video từ link...");
      const url = nodeData.prompt;
      if (!url) throw new Error("Chưa nhập URL video");
      const { runCloneVideo } = await import("./providers/clone");
      const videoItems = await runCloneVideo(job, nodeData, url, log);
      assignOutputItems(output, videoItems, "video");
      setJobProgress(job.id, 100);
    } else {
      throw new Error(`Node kind không support: ${kind}`);
    }

    output.status = "done";
    output.progress = 100;
    setJobOutput(job.id, output);
    setJobStatus(job.id, "done");
    return output;
  } catch (err) {
    if (err instanceof JobCancelledError) {
      setJobStatus(job.id, "cancelled", { error: "Cancelled" });
      throw err;
    }
    // Log the full error object (with stack + any attached fields) BEFORE
    // converting to string — setJobError will log too, but only the short
    // message. We want the stack on disk for post-mortem debugging.
    logError({
      context: `executor.${nodeData.kind}`,
      error: err,
      extra: {
        jobId: job.id,
        nodeId: job.nodeId,
        workflowRunId: job.workflowRunId,
        kind: nodeData.kind,
        inputsCount: inputs.length,
      },
    });
    const msg = err instanceof Error ? err.message : String(err);
    setJobError(job.id, msg);
    throw err;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Each node holds a single result. If the provider returns multiple items:
 *  - items[0] → stored in output.outputs[0] plus imageUrl/videoUrl shortcuts
 *  - items[1..] → stored in output.outputsOverflow → the client will spawn clone nodes.
 */
function assignOutputItems(
  output: NodeDataBase,
  items: OutputItem[],
  type: "image" | "video"
) {
  if (!items.length) return;
  const first = items[0];
  output.outputs = [first];
  if (type === "image") {
    output.imageUrl = first.imageUrl;
    output.imageMediaId = first.imageMediaId;
  } else {
    output.videoUrl = first.videoUrl;
    output.videoHdUrl = first.videoHdUrl;
  }
  if (items.length > 1) {
    // Pass overflow to the client to spawn clones
    output.outputsOverflow = items.slice(1);
  }
}

function isContent(kind: NodeKind): boolean {
  return kind.startsWith("content.") && kind !== "content.clone";
}

async function urlToBase64(url: string): Promise<string> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return comma > 0 ? url.slice(comma + 1) : "";
  }
  // A URL pointing at this tool's own files (/api/workflows/... or
  // /api/files/...) is on the same disk — skip the HTTP roundtrip so the
  // executor works even when the Next server is busy or the port isn't
  // accessible from the node fetching context.
  const local = resolveLocalMediaPath(url);
  if (local) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(local);
    return buf.toString("base64");
  }
  const { request } = await import("undici");
  const { body } = await request(url);
  const buf = Buffer.from(await body.arrayBuffer());
  return buf.toString("base64");
}

/** Resolve mediaId: use existing mediaId or upload base64/url → VEO. */
async function resolveVeoMediaId(
  img: NodeDataBase,
  aspectRatio: string,
  log?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<string> {
  if (img.imageMediaId) return img.imageMediaId;
  let b64 = img.uploadBase64;
  const mime = img.uploadMime || "image/png";
  if (!b64 && img.imageUrl) {
    log?.("Đang tải ảnh để upload…");
    b64 = await urlToBase64(img.imageUrl);
  }
  if (!b64) throw new Error("Không có dữ liệu ảnh để upload lên VEO");
  const ar = aspectRatio === "9:16" ? "IMAGE_ASPECT_RATIO_PORTRAIT" : "IMAGE_ASPECT_RATIO_LANDSCAPE";
  return veoUploadImage({ base64Image: b64, mimeType: mime, aspectRatio: ar }, log, shouldCancel);
}

type LogFn = (msg: string) => void;

async function runVeoCreateImage(
  job: JobRecord,
  nodeData: NodeDataBase,
  references: NodeDataBase[],
  log: LogFn
): Promise<OutputItem[]> {
  assertNotCancelled(job.id);
  const shouldCancel = makeShouldCancel(job.id);
  const aspectRatio =
    nodeData.aspectRatio === "9:16"
      ? "IMAGE_ASPECT_RATIO_PORTRAIT"
      : nodeData.aspectRatio === "1:1"
        ? "IMAGE_ASPECT_RATIO_SQUARE"
        : "IMAGE_ASPECT_RATIO_LANDSCAPE";

  const modelLabel = nodeData.modelLabel || "Nano Banana 2";
  const modelKey = CREATE_IMAGE_MODEL_TO_KEY[modelLabel] || "NARWHAL";
  const supportsRef = MODEL_SUPPORTS_REFERENCE[modelKey] ?? false;

  // Resolve each upstream image to a Flow media-asset id. For reference images
  // we pass whatever id we have (plain UUID from generated images, or CAM-prefixed
  // id from uploads) as the `name` field — both formats are accepted by the
  // `batchGenerateImages` API. Only bytes-only images (no cached id) need upload.
  const referenceImages: Array<{ mediaGenerationId: string; imageInputType?: string }> = [];
  if (references.length && !supportsRef) {
    log(`Model "${modelLabel}" không hỗ trợ reference image — ảnh upstream sẽ bị bỏ qua. Chọn Nano Banana 2 / pro nếu muốn dùng reference.`);
  } else if (references.length) {
    // R1.1 — resolve references in parallel. Each upload is an independent
    // HTTP call (no reCAPTCHA involved), and VEO's UI itself fires these in
    // parallel. We cap concurrency at 3 to avoid overwhelming the account.
    const resolved = await pMapLimited(references, 3, async (r, i) => {
      try {
        const mediaGenerationId = await resolveVeoMediaId(
          r,
          nodeData.aspectRatio || "16:9",
          log,
          shouldCancel,
        );
        log(`Reference #${i + 1} ready (name=${mediaGenerationId.slice(0, 24)}…).`);
        return { ok: true as const, mediaGenerationId };
      } catch (err) {
        if (err instanceof JobCancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        log(`Chuẩn bị reference #${i + 1} thất bại: ${msg} — bỏ qua ảnh này.`);
        return { ok: false as const };
      }
    });
    for (const r of resolved) {
      if (r.ok) {
        referenceImages.push({
          mediaGenerationId: r.mediaGenerationId,
          imageInputType: "IMAGE_INPUT_TYPE_REFERENCE",
        });
      }
    }
    if (!referenceImages.length) {
      log("Không có reference nào khả dụng — fallback sang text-to-image thuần.");
    }
  }

  const { raw } = await veoCreateImage(
    {
      prompt: nodeData.prompt || "",
      modelLabel,
      outputCount: nodeData.outputCount || 1,
      aspectRatio,
      seed: typeof nodeData.seed === "number" ? nodeData.seed : undefined,
      referenceImages: referenceImages.length ? referenceImages : undefined,
    },
    log,
    shouldCancel,
  );
  if (!raw.length) throw new Error("VEO không trả về image nào");

  // Persist every result to disk so the preview doesn't die when the user
  // signs out of the Google account that generated it. VEO returns either a
  // signed CDN URL (download via `veoDownload`) or inline base64 bytes (just
  // write them). When we have no workflow id the file lands in downloads/ —
  // still better than a remote URL that can vanish.
  return await Promise.all(
    raw.map(async (img, i) => {
      const ext = extFromMime(img.mimeType) || "png";
      const fileName = `veo_img_${job.id}_${i}.${ext}`;
      let url: string | undefined;
      try {
        if (img.rawBytes) {
          const file = await writeBase64Asset(
            job.workflowRunId,
            fileName,
            img.rawBytes,
          );
          url = downloadedAssetUrl(job.workflowRunId, file);
        } else if (img.imageUrl) {
          const file = await veoDownload(
            img.imageUrl,
            fileName,
            undefined,
            undefined,
            job.workflowRunId,
          );
          url = downloadedAssetUrl(job.workflowRunId, file);
        }
      } catch (err) {
        log(`Không lưu được ảnh #${i + 1} (${err instanceof Error ? err.message : err}) — dùng URL gốc.`);
      }
      if (!url) {
        url = img.rawBytes
          ? `data:${img.mimeType || "image/png"};base64,${img.rawBytes}`
          : img.imageUrl;
      }
      return { imageUrl: url, imageMediaId: img.mediaId, mimeType: img.mimeType };
    }),
  );
}

function extFromMime(mime: string | undefined): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  return null;
}

async function runVeoT2V(
  job: JobRecord,
  nodeData: NodeDataBase,
  log: LogFn
): Promise<OutputItem[]> {
  assertNotCancelled(job.id);
  const shouldCancel = makeShouldCancel(job.id);
  const aspect =
    nodeData.aspectRatio === "9:16"
      ? "VIDEO_ASPECT_RATIO_PORTRAIT"
      : "VIDEO_ASPECT_RATIO_LANDSCAPE";
  const modelKey =
    nodeData.videoModelKey || resolveT2vModelKey(nodeData.modelLabel, nodeData.aspectRatio);
  const { operations } = await veoTextToVideo(
    {
      prompt: nodeData.prompt || "",
      aspectRatio: aspect,
      outputCount: nodeData.outputCount || 1,
      seed: typeof nodeData.seed === "number" ? nodeData.seed : undefined,
      modelKey,
    },
    log,
    shouldCancel,
  );
  const entries = await veoWaitForVideos(operations, (es) => {
    const pcts = es.map((e) => e.progressPercent || 0).filter((p) => p > 0);
    const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    if (avg > 0) log(`Đang xử lý… ${avg}%`);
    setJobProgress(job.id, Math.min(99, avg || 5));
  }, { shouldCancel });
  const videos = entries.filter((e) => e.videoUrl);
  if (!videos.length) throw new Error("VEO không trả về videoUrl");
  log("Video xong, đang tải về…");
  // R1.2 — download outputs in parallel (typically 1-3 videos per job).
  const items = await Promise.all(
    videos.map(async (v, i) => {
      let url = v.videoUrl!;
      try {
        const file = await veoDownload(
          url,
          `veo_${job.id}_${i}.mp4`,
          undefined,
          undefined,
          job.workflowRunId,
        );
        url = downloadedAssetUrl(job.workflowRunId, file);
      } catch { /* keep original */ }
      return { videoUrl: url } satisfies OutputItem;
    })
  );
  return items;
}

/**
 * Shared by gen.image-to-video.veo, gen.start-end.veo, and
 * gen.text-to-video.veo when there is an upstream image (image → start frame).
 */
async function runVeoI2V(
  job: JobRecord,
  nodeData: NodeDataBase,
  startImage: NodeDataBase,
  endImage: NodeDataBase | undefined,
  log: LogFn
): Promise<OutputItem[]> {
  assertNotCancelled(job.id);
  const shouldCancel = makeShouldCancel(job.id);
  const aspect =
    nodeData.aspectRatio === "9:16"
      ? "VIDEO_ASPECT_RATIO_PORTRAIT"
      : "VIDEO_ASPECT_RATIO_LANDSCAPE";
  const isStartEnd = Boolean(endImage);

  const startMediaId = await resolveVeoMediaId(
    startImage,
    nodeData.aspectRatio || "16:9",
    log,
    shouldCancel,
  );

  let endMediaId: string | undefined;
  if (endImage) {
    log("Đang upload ảnh end frame…");
    endMediaId = await resolveVeoMediaId(
      endImage,
      nodeData.aspectRatio || "16:9",
      log,
      shouldCancel,
    );
  }

  const modelKey =
    nodeData.videoModelKey ||
    resolveI2vModelKey(nodeData.modelLabel, nodeData.aspectRatio, isStartEnd);

  const { operations } = await veoImageToVideo(
    {
      prompt: nodeData.prompt || "",
      startMediaId,
      endMediaId,
      aspectRatio: aspect,
      outputCount: nodeData.outputCount || 1,
      seed: typeof nodeData.seed === "number" ? nodeData.seed : undefined,
      modelKey,
    },
    log,
    shouldCancel,
  );
  const entries = await veoWaitForVideos(operations, (es) => {
    const pcts = es.map((e) => e.progressPercent || 0).filter((p) => p > 0);
    const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
    if (avg > 0) log(`Đang xử lý… ${avg}%`);
    setJobProgress(job.id, Math.min(99, avg || 5));
  }, { shouldCancel });
  const videos = entries.filter((e) => e.videoUrl);
  if (!videos.length) throw new Error("VEO không trả về videoUrl");
  log("Video xong, đang tải về…");
  // R1.2 — download outputs in parallel.
  const items = await Promise.all(
    videos.map(async (v, i) => {
      let url = v.videoUrl!;
      try {
        const file = await veoDownload(
          url,
          `veo_${job.id}_${i}.mp4`,
          undefined,
          undefined,
          job.workflowRunId,
        );
        url = downloadedAssetUrl(job.workflowRunId, file);
      } catch { /* keep */ }
      return { videoUrl: url } satisfies OutputItem;
    })
  );
  return items;
}

async function runGrokT2V(
  job: JobRecord,
  nodeData: NodeDataBase,
  log: LogFn
): Promise<OutputItem[]> {
  assertNotCancelled(job.id);
  log("Đang gửi request tạo video Grok…");
  const res = await grokT2V({
    prompt: nodeData.prompt || "",
    config: {
      aspectRatio: (nodeData.aspectRatio as "9:16" | "16:9" | "1:1") || "9:16",
      videoLength: clampGrokLength(nodeData.videoLength),
      // Default to 720p so workflow previews match the "min 720p" policy;
      // respect the user's explicit pick if they lowered it to 480p.
      resolutionName: nodeData.resolution || "720p",
    },
    onProgress: (p) => {
      if (p.progress) log(`Grok đang xử lý… ${p.progress}%`);
      setJobProgress(job.id, Math.min(99, p.progress || 1));
    },
  });
  if (!res.mediaUrl) {
    const promptForScan = nodeData.prompt || "";
    const rejectHint = interpretGrokRejection(res.convoError, promptForScan);
    const hint = rejectHint ?? interpretGrokError(res.convoStatus, res.convoError);
    throw new Error(
      `Grok t2v failed (status=${res.convoStatus})${hint ? ` — ${hint}` : ""}${res.convoError ? `\nGrok response: ${res.convoError}` : ""}`
    );
  }
  log("Video xong, đang tải về…");
  const mediaUrl = normalizeGrokMediaUrl(res.mediaUrl)!;
  const hdMediaUrl = normalizeGrokMediaUrl(res.hdMediaUrl);
  let vUrl = mediaUrl;
  try {
    const file = await grokDownloadVideo(
      mediaUrl,
      `grok_${job.id}.mp4`,
      undefined,
      job.workflowRunId,
    );
    vUrl = downloadedAssetUrl(job.workflowRunId, file);
    log("Video đã lưu thành công.");
  } catch (dlErr) {
    log(`Download thất bại (${dlErr instanceof Error ? dlErr.message : dlErr}), dùng URL gốc.`);
  }
  return [{ videoUrl: vUrl, videoHdUrl: hdMediaUrl || undefined }];
}

/**
 * Scan a prompt for patterns that frequently trigger Grok's silent
 * content-moderation ("hallucinatedSuccess"). Returns the list of exact
 * substrings found so we can show the user concrete evidence instead of
 * hand-wavy "thường do bikini/…".
 *
 * Grouped by category:
 *   - swimwear/underwear
 *   - sexualized motion
 *   - close-up + subject combo (NSFW-adjacent framing)
 *   - identity-sensitive (celebrity, copyrighted characters — lists kept
 *     short; rely on user to add custom patterns later if needed)
 *   - violence / weapon
 *
 * We match case-insensitively and return the canonical matched phrase from
 * the prompt (not the regex). Duplicates are deduped.
 */
function scanGrokRiskyTriggers(prompt: string): string[] {
  if (!prompt) return [];
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /\bbikini\b/gi, label: "bikini" },
    { re: /\bswimsuit\b/gi, label: "swimsuit" },
    { re: /\blingerie\b/gi, label: "lingerie" },
    { re: /\bunderwear\b/gi, label: "underwear" },
    { re: /\btopless\b/gi, label: "topless" },
    { re: /\bnaked\b|\bnude\b/gi, label: "naked/nude" },
    { re: /\bsways?\s+(?:her|his|their)\s+hips?\b/gi, label: "sways hips" },
    { re: /\bhips?\s+sway(?:ing|s)?\b/gi, label: "hips sway" },
    { re: /\b(?:body|hips?|chest)\s+moves?\b/gi, label: "body/hips moves" },
    { re: /\bsensual(?:ly)?\b|\bseductive(?:ly)?\b|\bflirty\b|\berotic\b/gi, label: "sensual/seductive" },
    { re: /\bsuggestive(?:ly)?\b/gi, label: "suggestive" },
    { re: /\bdanc(?:e|es|ing)\s+(?:slowly|sensual|seductive|close)/gi, label: "suggestive dancing" },
    { re: /\bclose[-\s]?up\b/gi, label: "close-up" },
    { re: /\byoung\s+(?:woman|girl|female|lady)\b/gi, label: "young woman/girl" },
    { re: /\bfabric\s+(?:moves|flows|clings)\b/gi, label: "fabric moves/flows" },
    { re: /\bwet\s+(?:shirt|top|clothes|body)\b/gi, label: "wet clothes" },
    { re: /\b(?:gun|rifle|pistol|firearm)\b/gi, label: "weapon" },
    { re: /\b(?:blood|gore|violent|stab|shoot)\b/gi, label: "violence" },
  ];
  const found = new Set<string>();
  for (const { re, label } of patterns) {
    if (re.test(prompt)) found.add(label);
    re.lastIndex = 0;
  }
  return Array.from(found);
}

/**
 * Build a deterministic, evidence-backed error hint for Grok rejections.
 * Called from runGrokI2V / runGrokT2V when we already have the structured
 * body (`convoError`) AND the original prompt.
 *
 * Strategy: detect if the body contains a soft-rejection signal
 * (hallucinatedSuccess / silentRejection / moderation / finishReason=safety).
 * If yes, scan the prompt for known triggers and assemble a hint that says
 * "100% reject + triggers found + evidence + concrete fix" — no "có thể".
 *
 * Returns null when the failure isn't a content-policy reject, so the
 * caller falls back to interpretGrokError's generic handling.
 */
function interpretGrokRejection(body: string | null | undefined, prompt: string): string | null {
  if (!body) return null;
  const b = body.toLowerCase();
  const isHallucinated = b.includes("hallucinatedsuccess=true");
  const isSilent = b.includes("silentrejection=true");
  const isModerated =
    b.includes("moderation=") ||
    b.includes("finishreason=safety") ||
    b.includes("finishreason=recitation");
  if (!isHallucinated && !isSilent && !isModerated) return null;

  const triggers = scanGrokRiskyTriggers(prompt);
  const triggerPart = triggers.length
    ? `Triggers phát hiện trong prompt: [${triggers.join(", ")}]`
    : "Không phát hiện trigger rõ ràng trong text prompt → khả năng cao do ẢNH input chứa yếu tố nhạy cảm (bikini/underwear/NSFW/celebrity…)";

  let evidence: string;
  let verdict: string;
  if (isHallucinated) {
    verdict = "BỊ REJECT BỞI GROK MODERATION (không phải bug, không phải transient)";
    evidence =
      'Bằng chứng: Grok KHÔNG gọi tool videoGen (sawSvr=false), chỉ trả text template "I generated a video…" — đây là cách Grok từ chối ngầm.';
  } else if (isSilent) {
    verdict = "BỊ REJECT BỞI GROK MODERATION (silent — không giải thích)";
    evidence =
      "Bằng chứng: Grok nhận prompt, echo lại, rồi đóng stream KHÔNG emit model output hay videoGen event.";
  } else {
    verdict = "BỊ REJECT BỞI GROK MODERATION (có flag safety/recitation)";
    evidence = "Bằng chứng: Grok trả moderation/finishReason flag trong stream.";
  }

  return `${verdict}. ${evidence} ${triggerPart}. Fix: bỏ/đổi các cụm trên khỏi prompt VÀ/HOẶC thay ảnh input, hoặc chuyển node sang Veo I2V (policy lỏng hơn)`;
}

/**
 * Map Grok HTTP status/body → a Vietnamese hint so the user can quickly understand the cause.
 */
function interpretGrokError(status: number, body?: string | null): string {
  const b = (body || "").toLowerCase();
  if (b.includes("invalid-parent-post") || b.includes("source post not found")) {
    return "parentPostId không hợp lệ — cần gọi /rest/media/post/create sau upload (đã fix, thử lại sau khi restart server)";
  }
  if (status === 404) {
    if (b.includes("parent-post") || b.includes("parentpost")) {
      return "Grok không tìm thấy post gốc — có thể image upload bị CDN chưa propagate, thử lại sau vài giây";
    }
    return "endpoint Grok không tồn tại hoặc resource missing";
  }
  if (status === 400) {
    if (b.includes("duration") || b.includes("videolength")) {
      return "videoLength phải trong khoảng 1-10 giây";
    }
    if (b.includes("resolution")) {
      return "resolutionName không hợp lệ (thử 480p)";
    }
    if (b.includes("aspect")) {
      return "aspectRatio không hợp lệ";
    }
    if (b.includes("prompt")) {
      return "prompt bị reject (có thể content policy)";
    }
    return "payload bị Grok từ chối — kiểm tra combo length/resolution/aspect";
  }
  if (status === 401 || status === 403) {
    return "session Grok hết hạn, mở Chrome Grok login lại";
  }
  if (status === 429) return "rate limit — thử lại sau 1-2 phút";
  if (status === 0) return "request bị cancel/timeout";
  // Status 200 but no media URL — body contains our structured hint
  // (moderation=… / finishReason=… / grokSays=… / streamAborted=… /
  // noMediaUrl progress=… videoId=… parentPostId=…). Translate the
  // most useful shapes to VN so the user knows whether to retry, edit
  // the prompt, or re-login.
  if (status === 200) {
    // Grok internal backend errors — NOT content policy. These are
    // transient failures on Grok's side (prompt upsampler returning
    // empty, downstream model timeout, capacity issues). Surface them
    // distinctly so the user knows to retry, not to rewrite the prompt.
    if (
      b.includes("upsampler") || b.includes("upsampling") ||
      b.includes("prompt upsampling failed") ||
      b.includes("internal error") || b.includes("internal_error") ||
      b.includes("backend error") || b.includes("service unavailable") ||
      b.includes("temporarily unavailable") || b.includes("try again")
    ) {
      return "Grok backend lỗi tạm thời (prompt upsampler/model internal error) — KHÔNG phải content policy. Hãy thử lại sau vài giây";
    }
    // Hallucinated success: Grok's text model viết kiểu
    // "I generated a video with the prompt: '…'" NHƯNG không
    // thực sự invoke videoGen tool. Đây là lớp moderation thứ hai
    // của Grok: từ chối bọc bằng phrasing lịch sự "tôi đã tạo".
    // Các trigger thường gặp: "bikini", "sways her hips",
    // "dancing (casually)", người phụ nữ close-up + chuyển động gợi
    // cảm, celebrity name, copyrighted character, bạo lực.
    if (b.includes("hallucinatedsuccess=true")) {
      return "Grok giả vờ đã tạo video nhưng thực tế không chạy videoGen — content bị moderation tinh vi (thường do: bikini/swimsuit, chuyển động cơ thể gợi cảm 'sways hips/dances slowly', người thật/celebrity, close-up phụ nữ). Bỏ/đổi các yếu tố này trong prompt rồi thử lại";
    }
    // Silent moderation: Grok nhận prompt, echo lại, rồi đóng stream
    // KHÔNG emit model output hay SVR event nào. Đây là dấu hiệu gần
    // như chắc chắn content bị chặn ngầm (hoặc ảnh hoặc prompt có yếu
    // tố nhạy cảm mà Grok không muốn giải thích — NSFW, bạo lực,
    // người thật/celebrity, copyright…).
    if (b.includes("silentrejection=true")) {
      return "Grok chặn ngầm không giải thích — gần như chắc chắn content bị coi là nhạy cảm (người thật/celebrity, NSFW, bạo lực, copyright…). Hãy đổi ảnh/prompt tránh các yếu tố này rồi thử lại";
    }
    if (b.includes("moderation=") || b.includes("finishreason=safety") || b.includes("finishreason=recitation")) {
      return "Grok từ chối tạo video do content policy (moderation flag) — đổi ảnh/prompt bớt nhạy cảm rồi thử lại";
    }
    if (b.includes("can't create") || b.includes("cannot create") ||
      b.includes("unable to create") || b.includes("content policy") || b.includes("guidelines") ||
      b.includes("not allowed") || b.includes("không thể tạo") ||
      (b.includes("against") && b.includes("policy"))) {
      return "Grok giải thích không thể tạo do content policy — xem nội dung grokSays bên dưới để biết chi tiết";
    }
    if (b.includes("finishreason=")) {
      return "Grok kết thúc sớm với finishReason bất thường — xem chi tiết trong Grok response bên dưới";
    }
    if (b.includes("streamaborted=") || b.includes("stream aborted")) {
      return "stream Grok bị ngắt giữa chừng — có thể do tab Grok navigate đi chỗ khác hoặc mạng chập chờn. Thử lại sau vài giây";
    }
    if (b.includes("no events received")) {
      return "Grok không gửi event nào — session có thể đã hết hạn (mở Chrome Grok kiểm tra)";
    }
    if (b.includes("grok says") || b.includes("grok response") || b.includes("grokSays")) {
      return "Grok trả lời bằng text thay vì tạo video — xem nội dung trong Grok response bên dưới (thường là lý do content policy)";
    }
    if (b.includes("nomediaurl") || b.includes("no mediaurl") || b.includes("progress=")) {
      return "Grok kết thúc stream nhưng không có videoUrl — có thể content bị reject ngầm hoặc Grok backend lỗi. Thử đổi prompt hoặc chạy lại";
    }
  }
  return "";
}

/**
 * Grok sometimes returns `videoUrl` as a relative path
 * (e.g. `users/<uid>/generated/<id>/generated_video.mp4`).
 * We must prefix it with `https://assets.grok.com/` before download/preview.
 */
function normalizeGrokMediaUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = String(u).trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  // Strip leading `/` if present
  return `${GROK_ASSETS_BASE}/${s.replace(/^\/+/, "")}`;
}

/** Clamp videoLength to the [1, 10] range accepted by Grok. */
function clampGrokLength(v: number | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return 6;
  if (n > 10) return 10;
  return Math.round(n);
}

/**
 * Shared by gen.image-to-video.grok and gen.text-to-video.grok when there is an upstream image.
 */
async function runGrokI2V(
  job: JobRecord,
  nodeData: NodeDataBase,
  imageInput: NodeDataBase,
  log: LogFn
): Promise<OutputItem[]> {
  assertNotCancelled(job.id);
  log("Đang upload ảnh lên Grok…");
  const base64 = imageInput.uploadBase64 || (await urlToBase64(imageInput.imageUrl || ""));
  const mime = imageInput.uploadMime || "image/png";
  const uploaded = await grokUpload({
    base64,
    fileName: imageInput.uploadFilePath || `upstream_${job.id}.png`,
    mimeType: mime,
  });
  log("Upload OK. Đang gửi request tạo video…");
  const res = await grokI2V({
    prompt: nodeData.prompt || "",
    fileMetadataId: uploaded.fileMetadataId,
    fileUri: uploaded.fileUri,
    config: {
      aspectRatio: (nodeData.aspectRatio as "9:16" | "16:9" | "1:1") || "9:16",
      videoLength: clampGrokLength(nodeData.videoLength),
      resolutionName: nodeData.resolution || "720p",
    },
    onProgress: (p) => {
      if (p.progress) log(`Grok đang xử lý… ${p.progress}%`);
      setJobProgress(job.id, Math.min(99, p.progress || 1));
    },
  });
  if (!res.mediaUrl) {
    const promptForScan = nodeData.prompt || "";
    const rejectHint = interpretGrokRejection(res.convoError, promptForScan);
    const hint = rejectHint ?? interpretGrokError(res.convoStatus, res.convoError);
    throw new Error(
      `Grok i2v failed (status=${res.convoStatus})${hint ? ` — ${hint}` : ""}${res.convoError ? `\nGrok response: ${res.convoError}` : ""}`
    );
  }
  log("Video xong, đang tải về…");
  const mediaUrl = normalizeGrokMediaUrl(res.mediaUrl)!;
  const hdMediaUrl = normalizeGrokMediaUrl(res.hdMediaUrl);
  let vUrl = mediaUrl;
  try {
    const file = await grokDownloadVideo(
      mediaUrl,
      `grok_${job.id}.mp4`,
      undefined,
      job.workflowRunId,
    );
    vUrl = downloadedAssetUrl(job.workflowRunId, file);
    log("Video đã lưu thành công.");
  } catch (dlErr) {
    log(`Download thất bại (${dlErr instanceof Error ? dlErr.message : dlErr}), dùng URL gốc.`);
  }
  return [{ videoUrl: vUrl, videoHdUrl: hdMediaUrl || undefined }];
}
