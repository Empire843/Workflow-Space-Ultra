/**
 * Shared prompt template for video scene analysis.
 * Used by all 3 providers (Gemini API, Gemini Playwright, ChatGPT Playwright).
 */

const BASE_PROMPT = `Analyze this video carefully. Split it into individual scenes where each scene represents one continuous shot (a new scene starts on each camera cut or significant transition).

CRITICAL LIMITATION: AI video generators (like VEO, Grok, Runway) can only generate max 4-5 seconds per request. If any continuous shot lasts longer than 5 seconds, you MUST artificially split it into multiple consecutive sub-scenes (e.g. "Subject enters room" then "Subject sits down", each being under 5 seconds). DO NOT output any scene that would require more than 5 seconds of video.

For each scene, provide:
- imagePrompt: a detailed, descriptive prompt to recreate this scene as a single still image using an AI image generator. Include subject, composition, lighting, style, colors, and mood.
- videoPrompt: a prompt describing the camera movement, motion, and action in the scene (e.g. "camera slowly pans left", "subject walks toward camera", "zoom in on face").

Return ONLY a valid JSON object with NO other text, NO markdown formatting, NO code fences. The JSON must follow this exact schema:
{"aspectRatio":"16:9","scenes":[{"imagePrompt":"...","videoPrompt":"..."}]}

Where aspectRatio is the detected aspect ratio of the video ("16:9", "9:16", or "1:1").`;

// Narration addendum appended when the caller asks the analyzer to also clone
// the voice-over. We require every scene entry to carry a `narration` key so
// downstream code can assume positional alignment; the model returns "" for
// silent shots instead of omitting the field. `detectedLanguage` drives voice
// selection in the TTS step (e.g. picking a Vietnamese voice for vi-vn).
const NARRATION_ADDENDUM = `

Additionally, for each scene, extract a third field:
- narration: the spoken voice-over or dialogue from the ORIGINAL audio track during this scene, transcribed in the original language. If the scene has no speech (silent, music only, or ambient sound), return "" (empty string). Do NOT translate; keep the original language verbatim but clean up filler sounds. Keep punctuation natural for text-to-speech playback.

Also add a top-level field:
- detectedLanguage: the BCP-47 language code of the dominant spoken language (e.g. "vi-vn", "en-us", "ja-jp"). If no speech at all, return "".

The updated JSON schema is:
{"aspectRatio":"16:9","detectedLanguage":"vi-vn","scenes":[{"imagePrompt":"...","videoPrompt":"...","narration":"..."}]}`;

export function buildAnalyzePrompt(opts?: {
  sceneCount?: number;
  aspectHint?: "16:9" | "9:16" | "1:1" | "auto";
  includeNarration?: boolean;
}): string {
  const parts = [BASE_PROMPT];

  if (opts?.includeNarration) {
    parts.push(NARRATION_ADDENDUM);
  }

  if (opts?.sceneCount && opts.sceneCount > 0) {
    parts.push(`\nSplit the video into exactly ${opts.sceneCount} scenes.`);
  }

  if (opts?.aspectHint && opts.aspectHint !== "auto") {
    parts.push(`\nThe video aspect ratio is ${opts.aspectHint}. Use this value for the "aspectRatio" field.`);
  }

  return parts.join("");
}
