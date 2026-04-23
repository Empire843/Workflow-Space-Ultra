/**
 * Gemini API provider for video analysis.
 * Uses the free Gemini REST API with an API key from aistudio.google.com.
 *
 * Flow:
 *   1. Upload video via Google File API (resumable upload)
 *   2. Wait for file to be processed (poll until state = ACTIVE)
 *   3. Call generateContent with video file ref + analysis prompt
 *   4. Parse JSON response → AnalyzeResult
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "@/server/config";
import type { AnalyzeVideoInput, AnalyzeResult } from "./types";
import { buildAnalyzePrompt } from "./prompt";
import { parseAnalyzeResponse, VideoAnalyzeParseError } from "./parseResponse";

const GEMINI_UPLOAD_URL =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_FILES_URL =
  "https://generativelanguage.googleapis.com/v1beta/files";
const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

/** Max video file size (bytes). Default 200 MB. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Poll interval when waiting for file processing (ms). */
const FILE_POLL_INTERVAL_MS = 2_000;
/** Max time to wait for file processing (ms). */
const FILE_POLL_TIMEOUT_MS = 5 * 60_000;
/** Timeout for generateContent call (ms). */
const GENERATE_TIMEOUT_MS = 5 * 60_000;

class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

function getApiKey(): string {
  const cfg = loadConfig();
  const key = cfg.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiApiError(
      "Chưa cấu hình Gemini API Key. " +
      "Vào Settings → Clone Video → nhập API key từ https://aistudio.google.com/apikey",
    );
  }
  return key;
}

function getModel(): string {
  const cfg = loadConfig();
  return cfg.GEMINI_MODEL || "gemini-2.5-flash";
}

// ── Step 1: Upload video file ────────────────────────────────────

interface UploadedFile {
  name: string;        // e.g. "files/abc123"
  uri: string;         // e.g. "https://generativelanguage.googleapis.com/v1beta/files/abc123"
  mimeType: string;
  state: string;
}

async function uploadVideoFile(
  videoPath: string,
  mimeType: string,
  apiKey: string,
): Promise<UploadedFile> {
  const stat = statSync(videoPath);
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new GeminiApiError(
      `Video quá lớn: ${(stat.size / 1024 / 1024).toFixed(1)} MB (giới hạn ${MAX_VIDEO_BYTES / 1024 / 1024} MB)`,
    );
  }

  const displayName = path.basename(videoPath, path.extname(videoPath));
  const fileData = readFileSync(videoPath);

  // Always use resumable upload (X-Goog-Upload-* headers).
  // The multipart/related simple upload format is fragile and causes
  // "Metadata part is too large" errors.
  return resumableUpload(fileData, mimeType, displayName, apiKey);
}

async function resumableUpload(
  fileData: Buffer,
  mimeType: string,
  displayName: string,
  apiKey: string,
): Promise<UploadedFile> {
  // Step 1: Initiate resumable upload
  const initUrl = `${GEMINI_UPLOAD_URL}?key=${apiKey}`;
  const initRes = await fetch(initUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fileData.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { displayName } }),
  });

  if (!initRes.ok) {
    const text = await initRes.text();
    throw new GeminiApiError(`Resumable upload init thất bại (${initRes.status}): ${text}`, initRes.status);
  }

  const uploadUrl = initRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) {
    throw new GeminiApiError("Resumable upload: không nhận được upload URL");
  }

  // Step 2: Upload file data
  const dataUint8 = new Uint8Array(fileData.buffer, fileData.byteOffset, fileData.byteLength);
  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(fileData.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: dataUint8 as unknown as BodyInit,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new GeminiApiError(`Upload data thất bại (${uploadRes.status}): ${text}`, uploadRes.status);
  }

  const json = (await uploadRes.json()) as { file: UploadedFile };
  return json.file;
}

// ── Step 2: Wait for file processing ─────────────────────────────

async function waitForFileProcessing(
  fileName: string,
  apiKey: string,
): Promise<void> {
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = `${GEMINI_FILES_URL}/${fileName}?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new GeminiApiError(`File status check thất bại (${res.status}): ${text}`, res.status);
    }

    const data = (await res.json()) as { state: string; error?: { message: string } };

    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED") {
      throw new GeminiApiError(
        `File processing thất bại: ${data.error?.message || "unknown error"}`,
      );
    }

    // PROCESSING — wait and retry
    await new Promise((r) => setTimeout(r, FILE_POLL_INTERVAL_MS));
  }

  throw new GeminiApiError(
    `File processing timeout sau ${FILE_POLL_TIMEOUT_MS / 1000}s. Video có thể quá lớn hoặc Gemini đang quá tải.`,
  );
}

// ── Step 3: Generate content ─────────────────────────────────────

async function generateContent(
  fileUri: string,
  fileMime: string,
  prompt: string,
  model: string,
  apiKey: string,
): Promise<string> {
  const url = `${GEMINI_GENERATE_URL}/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [
          {
            fileData: {
              mimeType: fileMime,
              fileUri,
            },
          },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      throw new GeminiApiError(
        "Rate limit — Gemini API đang quá tải. Đợi 1-2 phút rồi thử lại.",
        429,
      );
    }
    throw new GeminiApiError(`generateContent thất bại (${res.status}): ${text}`, res.status);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiApiError("Gemini trả về response rỗng. Thử lại.");
  }

  return text;
}

// ── Step 4: Cleanup uploaded file ────────────────────────────────

async function deleteFile(fileName: string, apiKey: string): Promise<void> {
  try {
    await fetch(`${GEMINI_FILES_URL}/${fileName}?key=${apiKey}`, { method: "DELETE" });
  } catch {
    // Best-effort cleanup, ignore errors
  }
}

// ── Public API ───────────────────────────────────────────────────

export async function analyzeWithGeminiApi(input: AnalyzeVideoInput): Promise<AnalyzeResult> {
  const apiKey = getApiKey();
  const model = getModel();
  const prompt = input.customPrompt || buildAnalyzePrompt({
    sceneCount: input.sceneCount,
    aspectHint: input.aspectHint,
    includeNarration: input.includeNarration,
  });

  // 1. Upload
  const file = await uploadVideoFile(input.videoPath, input.mimeType, apiKey);

  // Extract just the file ID from the name (e.g. "abc123" from "files/abc123")
  const fileId = file.name.startsWith("files/") ? file.name.slice(6) : file.name;

  try {
    // 2. Wait for processing
    await waitForFileProcessing(fileId, apiKey);

    // 3. Generate analysis
    const rawText = await generateContent(file.uri, input.mimeType, prompt, model, apiKey);

    // 4. Parse
    try {
      return parseAnalyzeResponse(rawText);
    } catch (e) {
      if (e instanceof VideoAnalyzeParseError) {
        // Retry once with stricter prompt
        const retryPrompt = prompt +
          "\n\nIMPORTANT: Your previous response was not valid JSON. " +
          "Return ONLY the JSON object, nothing else. No markdown, no explanation.";
        const retryText = await generateContent(file.uri, input.mimeType, retryPrompt, model, apiKey);
        return parseAnalyzeResponse(retryText);
      }
      throw e;
    }
  } finally {
    // 5. Cleanup uploaded file
    await deleteFile(fileId, apiKey);
  }
}
