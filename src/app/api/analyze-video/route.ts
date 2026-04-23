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

import { create as createYtdl } from "youtube-dl-exec";

const youtubedl = createYtdl(
  process.env.YTDLP_PATH ||
  "C:\\Users\\kienq\\AppData\\Local\\Programs\\Python\\Python310\\Scripts\\yt-dlp.exe"
);

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
    const youtubeUrl = formData.get("youtubeUrl") as string | null;

    if (!videoFile && !youtubeUrl) {
      return NextResponse.json(
        { error: "Thiếu field 'video' hoặc 'youtubeUrl'" },
        { status: 400 },
      );
    }

    if (videoFile && videoFile instanceof File) {
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

    let tmpPath = "";
    let mimeTypeForAnalyzer = "video/mp4";

    if (youtubeUrl) {
      tmpPath = path.join(TMP_DIR, `${randomUUID()}.mp4`);
      const ytdlpBin = process.env.YTDLP_PATH || "C:\\Users\\kienq\\AppData\\Local\\Programs\\Python\\Python310\\Scripts\\yt-dlp.exe";
      console.log("[analyze-video] Downloading from URL:", youtubeUrl);
      console.log("[analyze-video] Output path:", tmpPath);

      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);

      try {
        const { stdout, stderr } = await execFileAsync(ytdlpBin, [
          youtubeUrl,
          "-o", tmpPath,
          "--format", "best[ext=mp4]/best",
          "--merge-output-format", "mp4",
          "--no-warnings",
        ], { timeout: 120_000 });
        if (stdout) console.log("[analyze-video] yt-dlp stdout:", stdout.slice(0, 500));
        if (stderr) console.log("[analyze-video] yt-dlp stderr:", stderr.slice(0, 500));
      } catch (dlErr: any) {
        console.error("[analyze-video] yt-dlp exec error:", dlErr.message);
        if (dlErr.stderr) console.error("[analyze-video] yt-dlp stderr:", dlErr.stderr.slice(0, 500));
        throw new Error(`Lỗi tải video từ URL: ${dlErr.message}`);
      }

      if (!existsSync(tmpPath)) {
        // Check what files yt-dlp actually created
        const { readdirSync } = await import("node:fs");
        const files = readdirSync(TMP_DIR);
        console.error("[analyze-video] File not found at", tmpPath, "| TMP_DIR contents:", files.slice(-10));
        throw new Error(`Video tải về nhưng file .mp4 không tồn tại. Kiểm tra log server.`);
      }
      console.log("[analyze-video] Download OK, file exists at", tmpPath);
      mimeTypeForAnalyzer = "video/mp4";
    } else if (videoFile && videoFile instanceof File) {
      const ext = path.extname(videoFile.name) || ".mp4";
      tmpPath = path.join(TMP_DIR, `${randomUUID()}${ext}`);
      const arrayBuffer = await videoFile.arrayBuffer();
      writeFileSync(tmpPath, Buffer.from(arrayBuffer));
      mimeTypeForAnalyzer = videoFile.type || "video/mp4";
    }

    try {
      const result = await analyzeVideo({
        videoPath: tmpPath,
        mimeType: mimeTypeForAnalyzer,
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
