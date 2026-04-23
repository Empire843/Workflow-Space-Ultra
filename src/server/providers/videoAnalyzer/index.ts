/**
 * Clone Video — provider router.
 * Reads VIDEO_ANALYZER_PROVIDER from config → dispatches to the correct backend.
 */

import { loadConfig } from "@/server/config";
import type { AnalyzeVideoInput, AnalyzeResult, VideoAnalyzerProvider } from "./types";

export type { AnalyzeVideoInput, AnalyzeResult, VideoAnalyzerProvider };
export { VideoAnalyzeParseError } from "./parseResponse";

/**
 * Analyze a video using the configured provider.
 * Lazy-imports the provider module to avoid loading Playwright when using gemini-api.
 */
export async function analyzeVideo(input: AnalyzeVideoInput): Promise<AnalyzeResult> {
  const cfg = loadConfig();
  const provider: VideoAnalyzerProvider = cfg.VIDEO_ANALYZER_PROVIDER || "gemini-api";

  switch (provider) {
    case "gemini-api": {
      const { analyzeWithGeminiApi } = await import("./geminiApi");
      return analyzeWithGeminiApi(input);
    }
    case "gemini-playwright": {
      // Phase 2 — not yet implemented
      throw new Error(
        "Provider 'gemini-playwright' chưa được implement. " +
        "Vui lòng chọn 'gemini-api' trong Settings → Clone Video.",
      );
    }
    case "chatgpt-playwright": {
      // Phase 2 — not yet implemented
      throw new Error(
        "Provider 'chatgpt-playwright' chưa được implement. " +
        "Vui lòng chọn 'gemini-api' trong Settings → Clone Video.",
      );
    }
    default:
      throw new Error(`Unknown video analyzer provider: ${provider}`);
  }
}
