/**
 * Clone Video — Multi-Provider Architecture types.
 *
 * Supports 3 analyzer backends:
 *   - gemini-api       : Direct Gemini REST API with free API key (recommended)
 *   - gemini-playwright: Playwright → aistudio.google.com (no API key needed)
 *   - chatgpt-playwright: Playwright → chatgpt.com
 */

export type VideoAnalyzerProvider =
  | "gemini-api"
  | "gemini-playwright"
  | "chatgpt-playwright";

export interface AnalyzeVideoInput {
  videoPath: string;
  mimeType: string;
  /** Hint for number of scenes. Undefined = let AI decide. */
  sceneCount?: number;
  /** Aspect ratio hint for the output. "auto" = let AI detect from video. */
  aspectHint?: "16:9" | "9:16" | "1:1" | "auto";
  /** Optional custom prompt override. When set, replaces the default prompt. */
  customPrompt?: string;
  /**
   * When true, the analyzer also transcribes/rewrites the original voice-over
   * per scene into `SceneResult.narration` and returns `AnalyzeResult.detectedLanguage`.
   * Intended for the "Clone TTS script" toggle in AnalyzeVideoDialog — it lets a
   * downstream TTS pass synthesise a matching voice-over. When the video has no
   * speech, every `narration` comes back as an empty string.
   */
  includeNarration?: boolean;
}

export interface SceneResult {
  imagePrompt: string;
  videoPrompt: string;
  /**
   * Per-scene narration text extracted from the original audio track.
   * Populated only when `AnalyzeVideoInput.includeNarration === true`. Empty
   * string means that scene has no speech (silent / music only).
   */
  narration?: string;
}

export interface AnalyzeResult {
  aspectRatio: "16:9" | "9:16" | "1:1";
  scenes: SceneResult[];
  /**
   * BCP-47 language code detected from the original audio (e.g. `vi-vn`, `en-us`).
   * Populated only when `includeNarration` was requested and speech was found.
   * Consumed by the TTS step to pick a matching voice/language pair.
   */
  detectedLanguage?: string;
  /** Full AI response text for debugging / fallback display. */
  rawResponse?: string;
}

/** Each provider implements this interface. */
export interface VideoAnalyzerBackend {
  analyze(input: AnalyzeVideoInput): Promise<AnalyzeResult>;
}
