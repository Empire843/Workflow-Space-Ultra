/**
 * Shared JSON response parser for video analysis results.
 * Extracts and validates the AnalyzeResult from raw AI response text.
 * Handles: raw JSON, code-fenced JSON, markdown-wrapped JSON.
 */

import { z } from "zod";
import type { AnalyzeResult } from "./types";

const SceneSchema = z.object({
  imagePrompt: z.string().min(1),
  videoPrompt: z.string().min(1),
  // Optional — only present when the caller asked for narration cloning. The
  // model must emit the key for EVERY scene when requested (we enforce that
  // contract in the prompt itself, not here, so older responses still parse).
  narration: z.string().optional(),
});

const AnalyzeResultSchema = z.object({
  aspectRatio: z.enum(["16:9", "9:16", "1:1"]),
  scenes: z.array(SceneSchema).min(1),
  // BCP-47 or empty string. We accept any string (don't enforce format) because
  // the model occasionally returns "und" / language name when it's unsure — the
  // TTS step will fall back to auto-detect for unknown codes.
  detectedLanguage: z.string().optional(),
});

/**
 * Try to extract a JSON object from the AI response text.
 * Handles several common formats:
 *   1. Raw JSON (entire response is JSON)
 *   2. Code-fenced JSON (```json ... ```)
 *   3. Code-fenced without language tag (``` ... ```)
 *   4. JSON embedded in prose (first { ... last })
 */
function extractJsonString(text: string): string | null {
  const trimmed = text.trim();

  // 1. Raw JSON — starts with {
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // 2. Code-fenced JSON
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // 3. Find first { and last } — greedy fallback
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

export class VideoAnalyzeParseError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message);
    this.name = "VideoAnalyzeParseError";
  }
}

/**
 * Parse an AI response into a validated AnalyzeResult.
 * Throws `VideoAnalyzeParseError` if the response cannot be parsed or validated.
 */
export function parseAnalyzeResponse(rawText: string): AnalyzeResult {
  const jsonStr = extractJsonString(rawText);
  if (!jsonStr) {
    throw new VideoAnalyzeParseError(
      "Không tìm thấy JSON hợp lệ trong response từ AI. " +
      "Hãy thử lại hoặc giảm số scene.",
      rawText,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new VideoAnalyzeParseError(
      "JSON parse thất bại. Response chứa JSON không hợp lệ.",
      rawText,
    );
  }

  const result = AnalyzeResultSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new VideoAnalyzeParseError(
      `JSON không đúng schema: ${issues}`,
      rawText,
    );
  }

  return { ...result.data, rawResponse: rawText };
}
