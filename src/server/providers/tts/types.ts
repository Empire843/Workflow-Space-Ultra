/**
 * Shared types for the Gemini TTS provider.
 *
 * TTS here is a side feature of Clone Video: the analyzer extracts per-scene
 * narration from the original audio track, and this provider synthesises a
 * matching voice-over that the user can download. The audio is NOT merged
 * into the generated videos — callers just hand the buffer back to the
 * browser as a data URL or zip.
 */

// Voice list + model IDs live in `src/lib/tts.ts` so client components can
// import them without pulling server modules. Re-export for server-side callers.
export {
  GEMINI_TTS_MODELS,
  GEMINI_TTS_VOICES,
  GEMINI_TTS_LANGUAGES,
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_LANGUAGE,
} from "@/lib/tts";
export type { GeminiTtsModel, GeminiTtsVoice, GeminiTtsLanguage } from "@/lib/tts";

export interface TtsSceneInput {
  /** Stable scene index — echoed back on output so the UI can zip by index. */
  index: number;
  /** Narration text to synthesise. Empty strings are skipped by the batcher. */
  text: string;
}

export interface TtsSceneOutput {
  index: number;
  /** WAV bytes, ready to be served or written to disk. */
  wavBuffer: Buffer;
  /** Stable MIME so the browser picks the right player. Always audio/wav. */
  mimeType: "audio/wav";
  /** Convenience for the zip/data-url path — saves a `.length` call on large buffers. */
  bytes: number;
}

export interface TtsBatchOptions {
  model?: GeminiTtsModel;
  voice?: GeminiTtsVoice | string;
  /** BCP-47 language code. `auto` / empty → skip the field, let Gemini infer. */
  language?: string;
}
