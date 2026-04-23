/**
 * Gemini Text-to-Speech provider (generativelanguage.googleapis.com).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/speech-generation
 *
 * Unlike the videoAnalyzer provider, TTS has no File API step — the text fits
 * inline in the request body. One round-trip per scene; rate limited to
 * `CONCURRENCY` parallel in-flight requests to stay under the preview tier's
 * request-per-minute cap. Failures on a single scene are surfaced as rejections
 * on that scene's promise and don't abort the batch.
 */

import { loadConfig } from "@/server/config";

import { pcmToWav } from "./pcmToWav";
import type {
  GeminiTtsModel,
  TtsBatchOptions,
  TtsSceneInput,
  TtsSceneOutput,
} from "./types";

const GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** One-shot request timeout. TTS for ~1k chars usually returns in < 10s. */
const TTS_TIMEOUT_MS = 60_000;

/** Batch concurrency cap — Gemini preview quota is ~10 RPM, 2 parallel stays well under. */
const CONCURRENCY = 2;

/** Soft char cap per scene. Above this we pre-truncate with a warning in the
 *  returned error to keep a single request under the 16k-output-token budget.
 *  24 kHz × 16-bit mono × ~120 s ≈ 16k tokens ≈ a 2-minute read of ~4000 chars. */
const MAX_CHARS_PER_SCENE = 4000;

class GeminiTtsError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "GeminiTtsError";
  }
}

export { GeminiTtsError };

function getApiKey(): string {
  const cfg = loadConfig();
  const key = cfg.GEMINI_API_KEY;
  if (!key) {
    throw new GeminiTtsError(
      "Chưa cấu hình Gemini API Key. " +
      "Vào Settings → Clone Video → nhập API key từ https://aistudio.google.com/apikey",
    );
  }
  return key;
}

function getDefaultModel(): GeminiTtsModel {
  const cfg = loadConfig();
  return cfg.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview";
}

function getDefaultVoice(): string {
  const cfg = loadConfig();
  return cfg.GEMINI_TTS_VOICE || "Kore";
}

function getDefaultLanguage(): string | undefined {
  const cfg = loadConfig();
  const lang = cfg.GEMINI_TTS_LANGUAGE;
  // Sentinel "auto" lets callers express "let Gemini pick from the text"; we
  // translate that into "omit the languageCode field" so the API uses its own
  // language detection instead of forcing a (possibly wrong) locale.
  if (!lang || lang === "auto") return undefined;
  return lang;
}

/**
 * Synthesise one scene. Lives as a standalone so the batcher can retry it
 * individually on 429 without re-running siblings.
 */
async function synthesiseOne(
  text: string,
  apiKey: string,
  model: string,
  voice: string,
  language: string | undefined,
): Promise<Buffer> {
  const url = `${GENERATE_URL}/${model}:generateContent`;

  const speechConfig: {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: string } };
    languageCode?: string;
  } = {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
  };
  if (language) speechConfig.languageCode = language;

  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      throw new GeminiTtsError(
        "Rate limit — Gemini TTS đang quá tải. Đợi ~1 phút rồi thử lại.",
        429,
      );
    }
    throw new GeminiTtsError(
      `generateContent (TTS) thất bại (${res.status}): ${errText}`,
      res.status,
    );
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string };
        }>;
      };
    }>;
  };

  const b64 = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    throw new GeminiTtsError(
      "Gemini TTS response không có audio (candidates[0].content.parts[0].inlineData.data rỗng)",
    );
  }

  const pcm = Buffer.from(b64, "base64");
  return pcmToWav(pcm);
}

/** Retry wrapper — Gemini occasionally returns a transient 429 on the first
 *  request after a cold idle; a single 2s-delay retry covers that case. */
async function synthesiseWithRetry(
  text: string,
  apiKey: string,
  model: string,
  voice: string,
  language: string | undefined,
): Promise<Buffer> {
  try {
    return await synthesiseOne(text, apiKey, model, voice, language);
  } catch (err) {
    if (err instanceof GeminiTtsError && err.statusCode === 429) {
      await new Promise((r) => setTimeout(r, 2_000));
      return await synthesiseOne(text, apiKey, model, voice, language);
    }
    throw err;
  }
}

/**
 * Generate WAV audio for every non-empty scene in parallel (capped). The input
 * ordering is preserved in the output — skipped (empty-narration) scenes are
 * dropped entirely so the caller can tell which ones got synthesised.
 */
export async function generateTtsForScenes(
  scenes: TtsSceneInput[],
  opts: TtsBatchOptions = {},
): Promise<TtsSceneOutput[]> {
  const apiKey = getApiKey();
  const model = opts.model || getDefaultModel();
  const voice = opts.voice || getDefaultVoice();
  const language = opts.language && opts.language !== "auto"
    ? opts.language
    : getDefaultLanguage();

  // Drop empties up-front — a silent scene shouldn't consume quota.
  const eligible = scenes.filter((s) => typeof s.text === "string" && s.text.trim() !== "");

  // Validate sizes before spinning up any network traffic.
  for (const s of eligible) {
    if (s.text.length > MAX_CHARS_PER_SCENE) {
      throw new GeminiTtsError(
        `Scene ${s.index + 1}: narration dài ${s.text.length} ký tự (giới hạn ${MAX_CHARS_PER_SCENE}). ` +
        `Rút gọn lại hoặc tách scene.`,
      );
    }
  }

  const out: TtsSceneOutput[] = new Array(eligible.length);

  // Hand-rolled pool: run CONCURRENCY workers pulling from a shared cursor.
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= eligible.length) return;
      const item = eligible[i];
      const wav = await synthesiseWithRetry(item.text, apiKey, model, voice, language);
      out[i] = {
        index: item.index,
        wavBuffer: wav,
        mimeType: "audio/wav",
        bytes: wav.length,
      };
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, () => worker());
  await Promise.all(workers);

  // Sort by original scene index so downstream zips/lists are stable even
  // though we appended into `out` in completion order per worker slot.
  return out.sort((a, b) => a.index - b.index);
}
