/**
 * Shared HTTP helpers for Gemini File API + generateContent.
 *
 * Accepts either an API-key or an OAuth Bearer token so the same
 * logic can be used by both geminiApi.ts (API key) and
 * geminiPlaywright.ts (AI Studio session Bearer token).
 *
 * Flow:
 *   1. Upload video via Google File API (resumable upload)
 *   2. Wait for file to be processed (poll until state = ACTIVE)
 *   3. Call generateContent with video file ref + analysis prompt
 *   4. Parse JSON response → AnalyzeResult
 *   5. Delete uploaded file (best-effort cleanup)
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AnalyzeVideoInput, AnalyzeResult } from "./types";
import { buildAnalyzePrompt } from "./prompt";
import { parseAnalyzeResponse, VideoAnalyzeParseError } from "./parseResponse";

export type GeminiAuth =
  | { kind: "apiKey"; key: string }
  | { kind: "bearer"; token: string };

export class GeminiCoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "GeminiCoreError";
  }
}

const GEMINI_UPLOAD_URL =
  "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_FILES_URL =
  "https://generativelanguage.googleapis.com/v1beta/files";
const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const FILE_POLL_INTERVAL_MS = 2_000;
const FILE_POLL_TIMEOUT_MS = 5 * 60_000;
const GENERATE_TIMEOUT_MS = 5 * 60_000;

// ── Auth helpers ──────────────────────────────────────────────────

function authParam(auth: GeminiAuth): string {
  return auth.kind === "apiKey" ? `?key=${auth.key}` : "";
}

function authHeaders(auth: GeminiAuth): Record<string, string> {
  return auth.kind === "bearer"
    ? { Authorization: `Bearer ${auth.token}` }
    : {};
}

// ── Step 1: Upload video file ─────────────────────────────────────

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
  state: string;
}

async function resumableUpload(
  fileData: Buffer,
  mimeType: string,
  displayName: string,
  auth: GeminiAuth,
): Promise<UploadedFile> {
  const initUrl = `${GEMINI_UPLOAD_URL}${authParam(auth)}`;
  const initRes = await fetch(initUrl, {
    method: "POST",
    headers: {
      ...authHeaders(auth),
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
    throw new GeminiCoreError(
      `Resumable upload init thất bại (${initRes.status}): ${text}`,
      initRes.status,
    );
  }

  const uploadUrl = initRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) {
    throw new GeminiCoreError("Resumable upload: không nhận được upload URL");
  }

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
    throw new GeminiCoreError(
      `Upload data thất bại (${uploadRes.status}): ${text}`,
      uploadRes.status,
    );
  }

  const json = (await uploadRes.json()) as { file: UploadedFile };
  return json.file;
}

async function uploadVideoFile(
  videoPath: string,
  mimeType: string,
  auth: GeminiAuth,
): Promise<UploadedFile> {
  const stat = statSync(videoPath);
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new GeminiCoreError(
      `Video quá lớn: ${(stat.size / 1024 / 1024).toFixed(1)} MB (giới hạn ${MAX_VIDEO_BYTES / 1024 / 1024} MB)`,
    );
  }
  const displayName = path.basename(videoPath, path.extname(videoPath));
  const fileData = readFileSync(videoPath);
  return resumableUpload(fileData, mimeType, displayName, auth);
}

// ── Step 2: Wait for file processing ─────────────────────────────

async function waitForFileProcessing(
  fileName: string,
  auth: GeminiAuth,
): Promise<void> {
  const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const url = `${GEMINI_FILES_URL}/${fileName}${authParam(auth)}`;
    const res = await fetch(url, { headers: authHeaders(auth) });
    if (!res.ok) {
      const text = await res.text();
      throw new GeminiCoreError(
        `File status check thất bại (${res.status}): ${text}`,
        res.status,
      );
    }

    const data = (await res.json()) as { state: string; error?: { message: string } };

    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED") {
      throw new GeminiCoreError(
        `File processing thất bại: ${data.error?.message || "unknown error"}`,
      );
    }

    await new Promise((r) => setTimeout(r, FILE_POLL_INTERVAL_MS));
  }

  throw new GeminiCoreError(
    `File processing timeout sau ${FILE_POLL_TIMEOUT_MS / 1000}s. Video có thể quá lớn hoặc Gemini đang quá tải.`,
  );
}

// ── Step 3: Generate content ──────────────────────────────────────

async function generateContent(
  fileUri: string,
  fileMime: string,
  prompt: string,
  model: string,
  auth: GeminiAuth,
): Promise<string> {
  const url = `${GEMINI_GENERATE_URL}/${model}:generateContent${authParam(auth)}`;

  const body = {
    contents: [
      {
        parts: [
          { fileData: { mimeType: fileMime, fileUri } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      throw new GeminiCoreError(
        "Rate limit — Gemini API đang quá tải. Đợi 1-2 phút rồi thử lại.",
        429,
      );
    }
    throw new GeminiCoreError(
      `generateContent thất bại (${res.status}): ${text}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new GeminiCoreError("Gemini trả về response rỗng. Thử lại.");
  }

  return text;
}

// ── Step 4: Cleanup ───────────────────────────────────────────────

async function deleteFile(fileName: string, auth: GeminiAuth): Promise<void> {
  try {
    await fetch(`${GEMINI_FILES_URL}/${fileName}${authParam(auth)}`, {
      method: "DELETE",
      headers: authHeaders(auth),
    });
  } catch {
    // Best-effort cleanup
  }
}

// ── Public API ────────────────────────────────────────────────────

export async function analyzeWithGeminiCore(
  auth: GeminiAuth,
  input: AnalyzeVideoInput,
  model: string,
): Promise<AnalyzeResult> {
  const prompt = input.customPrompt || buildAnalyzePrompt({
    sceneCount: input.sceneCount,
    aspectHint: input.aspectHint,
    includeNarration: input.includeNarration,
  });

  const file = await uploadVideoFile(input.videoPath, input.mimeType, auth);
  const fileId = file.name.startsWith("files/") ? file.name.slice(6) : file.name;

  try {
    await waitForFileProcessing(fileId, auth);

    const rawText = await generateContent(file.uri, input.mimeType, prompt, model, auth);

    try {
      return parseAnalyzeResponse(rawText);
    } catch (e) {
      if (e instanceof VideoAnalyzeParseError) {
        const retryPrompt =
          prompt +
          "\n\nIMPORTANT: Your previous response was not valid JSON. " +
          "Return ONLY the JSON object, nothing else. No markdown, no explanation.";
        const retryText = await generateContent(file.uri, input.mimeType, retryPrompt, model, auth);
        return parseAnalyzeResponse(retryText);
      }
      throw e;
    }
  } finally {
    await deleteFile(fileId, auth);
  }
}
