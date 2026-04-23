/**
 * Shared TTS constants — safe to import from both client and server.
 *
 * Kept in `src/lib/` (not `src/server/`) so React components in `src/components/`
 * can pull in the voice list / model IDs without dragging in Node-only modules.
 * The server's TTS provider re-exports these from `providers/tts/types.ts` so
 * there's exactly one source of truth.
 */

export const GEMINI_TTS_MODELS = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
] as const;

export type GeminiTtsModel = (typeof GEMINI_TTS_MODELS)[number];

/**
 * 30 prebuilt voice names exposed by Gemini TTS. Alphabetical to make the
 * dropdown readable; we keep it a flat list rather than grouping by gender
 * because Google's voice catalog doesn't expose that metadata officially and
 * we'd rather not hand-classify 30 voices.
 */
export const GEMINI_TTS_VOICES = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede",
  "Autonoe", "Callirrhoe", "Charon", "Despina", "Enceladus", "Erinome",
  "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda",
  "Orus", "Puck", "Pulcherrima", "Rasalgethi", "Sadachbia", "Sadaltager",
  "Schedar", "Sulafat", "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
] as const;

export type GeminiTtsVoice = (typeof GEMINI_TTS_VOICES)[number];

/**
 * Top BCP-47 codes supported by Gemini TTS (the API supports ~80; we list the
 * most common ones in the dropdown with "auto" as the first entry so users can
 * let the model infer from the narration text itself — which is usually what
 * you want since the narration comes from the source video).
 */
export const GEMINI_TTS_LANGUAGES = [
  { value: "auto",   label: "Auto (detect from text)" },
  { value: "vi-vn",  label: "Tiếng Việt" },
  { value: "en-us",  label: "English (US)" },
  { value: "en-gb",  label: "English (UK)" },
  { value: "ja-jp",  label: "日本語" },
  { value: "ko-kr",  label: "한국어" },
  { value: "cmn-cn", label: "中文 (普通话)" },
  { value: "es-us",  label: "Español (US)" },
  { value: "es-es",  label: "Español (ES)" },
  { value: "fr-fr",  label: "Français" },
  { value: "de-de",  label: "Deutsch" },
  { value: "hi-in",  label: "हिन्दी" },
  { value: "id-id",  label: "Bahasa Indonesia" },
  { value: "th-th",  label: "ภาษาไทย" },
] as const;

export type GeminiTtsLanguage = (typeof GEMINI_TTS_LANGUAGES)[number]["value"];

export const DEFAULT_TTS_MODEL: GeminiTtsModel = "gemini-3.1-flash-tts-preview";
export const DEFAULT_TTS_VOICE: GeminiTtsVoice = "Kore";
export const DEFAULT_TTS_LANGUAGE: GeminiTtsLanguage = "auto";
