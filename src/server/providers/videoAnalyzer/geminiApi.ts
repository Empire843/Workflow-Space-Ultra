/**
 * Gemini API provider for video analysis.
 * Uses the free Gemini REST API with an API key from aistudio.google.com.
 * Delegates to geminiCore.ts for the shared HTTP logic.
 */

import { loadConfig } from "@/server/config";
import type { AnalyzeVideoInput, AnalyzeResult } from "./types";
import { analyzeWithGeminiCore, GeminiCoreError } from "./geminiCore";

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

export async function analyzeWithGeminiApi(input: AnalyzeVideoInput): Promise<AnalyzeResult> {
  const key = getApiKey();
  const model = getModel();
  try {
    return await analyzeWithGeminiCore({ kind: "apiKey", key }, input, model);
  } catch (e) {
    if (e instanceof GeminiCoreError) {
      throw new GeminiApiError(e.message, e.statusCode);
    }
    throw e;
  }
}
