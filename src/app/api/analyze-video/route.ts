/**
 * POST /api/analyze-video
 *
 * Accepts a video file (multipart/form-data) and analyzes it using
 * the configured video analyzer provider (Gemini API by default).
 *
 * Request: multipart/form-data
 *   - video: File (required) — video file to analyze
 *   - sceneCount: string (optional) — number of scenes to split into
 *   - aspectHint: string (optional) — "16:9" | "9:16" | "1:1" | "auto"
 *
 * Response: JSON AnalyzeResult
 */

import { NextResponse } from "next/server";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

import { analyzeVideo, VideoAnalyzeParseError } from "@/server/providers/videoAnalyzer";

const TMP_DIR = path.join(os.tmpdir(), "wsu-analyze-video");

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Content-Type phải là multipart/form-data" },
        { status: 415 },
      );
    }

    const formData = await request.formData();
    const videoFile = formData.get("video");

    if (!videoFile || !(videoFile instanceof File)) {
      return NextResponse.json(
        { error: "Thiếu field 'video' (file upload)" },
        { status: 400 },
      );
    }

    // Validate mime type
    const allowedMimes = [
      "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
      "video/x-matroska", "video/mpeg", "video/3gpp",
    ];
    if (!allowedMimes.some((m) => videoFile.type.startsWith(m.split("/")[0]))) {
      return NextResponse.json(
        { error: `Loại file không hỗ trợ: ${videoFile.type}. Cần video (mp4, webm, mov, avi, mkv).` },
        { status: 400 },
      );
    }

    // Parse optional params
    const sceneCountRaw = formData.get("sceneCount");
    const sceneCount = sceneCountRaw ? parseInt(String(sceneCountRaw), 10) : undefined;
    const aspectHint = (formData.get("aspectHint") as string) || undefined;
    // Accept both "true"/"1" and the raw string "on" (browser FormData from
    // <input type="checkbox"> serializes as "on" when no explicit value is set).
    const includeNarrationRaw = formData.get("includeNarration");
    const includeNarration = includeNarrationRaw
      ? ["true", "1", "on"].includes(String(includeNarrationRaw).toLowerCase())
      : false;

    // Save to temp file
    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const ext = path.extname(videoFile.name) || ".mp4";
    const tmpPath = path.join(TMP_DIR, `${randomUUID()}${ext}`);

    const arrayBuffer = await videoFile.arrayBuffer();
    writeFileSync(tmpPath, Buffer.from(arrayBuffer));

    try {
      const result = await analyzeVideo({
        videoPath: tmpPath,
        mimeType: videoFile.type || "video/mp4",
        sceneCount: sceneCount && sceneCount > 0 ? sceneCount : undefined,
        aspectHint: aspectHint as "16:9" | "9:16" | "1:1" | "auto" | undefined,
        includeNarration,
      });

      return NextResponse.json(result);
    } finally {
      // Cleanup temp file
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    if (err instanceof VideoAnalyzeParseError) {
      return NextResponse.json(
        {
          error: err.message,
          rawResponse: err.rawResponse,
        },
        { status: 422 },
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error("[analyze-video]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
