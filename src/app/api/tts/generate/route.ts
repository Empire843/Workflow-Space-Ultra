/**
 * POST /api/tts/generate
 *
 * Synthesise Gemini TTS audio for one or more scenes. The per-scene narration
 * text usually comes from the `AnalyzeVideoDialog` after a video has been
 * "Clone video"-d with the "Clone TTS script" toggle enabled — but the route
 * accepts any narration list so the feature can be reused by other UI hooks.
 *
 * Request JSON:
 *   {
 *     scenes: [{ index: number, narration: string }],
 *     voice?: string,        // prebuilt voice name (default config)
 *     language?: string,     // BCP-47 code, "auto" or omit to infer
 *     model?: string         // override config model
 *   }
 *
 * Response — JSON mode (default):
 *   { items: [{ index, audioDataUrl, mimeType, bytes }] }
 *
 * Response — zip mode (`?format=zip`):
 *   application/zip, one `scene-<NN>.wav` per non-empty scene.
 *
 * Error: JSON { error, statusCode? } with HTTP 4xx/5xx.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { generateTtsForScenes, GeminiTtsError } from "@/server/providers/tts/geminiTts";
import type { TtsSceneInput } from "@/server/providers/tts/types";
import { buildStoredZip } from "@/server/util/storedZip";

const BodySchema = z.object({
  scenes: z
    .array(
      z.object({
        index: z.number().int().min(0),
        narration: z.string(),
      }),
    )
    .min(1),
  voice: z.string().optional(),
  language: z.string().optional(),
  model: z
    .enum([
      "gemini-3.1-flash-tts-preview",
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-pro-preview-tts",
    ])
    .optional(),
});

export async function POST(request: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: `Body không hợp lệ: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "Body phải là JSON" }, { status: 400 });
  }

  const scenes: TtsSceneInput[] = body.scenes.map((s) => ({
    index: s.index,
    text: s.narration,
  }));

  try {
    const results = await generateTtsForScenes(scenes, {
      voice: body.voice,
      language: body.language,
      model: body.model,
    });

    if (results.length === 0) {
      return NextResponse.json(
        {
          error:
            "Không có scene nào có narration để synthesise (toàn bộ narration đều rỗng).",
        },
        { status: 422 },
      );
    }

    const url = new URL(request.url);
    const format = url.searchParams.get("format");

    if (format === "zip") {
      // Scene numbering is 1-based in filenames to match UI display.
      const entries = results.map((r) => ({
        name: `scene-${String(r.index + 1).padStart(2, "0")}.wav`,
        data: r.wavBuffer,
      }));
      const zip = buildStoredZip(entries);
      const zipBody = new Uint8Array(zip);
      return new NextResponse(zipBody, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="tts-scenes.zip"',
          "Content-Length": String(zipBody.byteLength),
          "Cache-Control": "no-store",
        },
      });
    }

    // JSON mode: inline data URLs. WAV files are small (100–500 KB / scene),
    // so the overhead of base64 over a raw download is acceptable and keeps
    // the client one-shot — no second round-trip per scene.
    const items = results.map((r) => ({
      index: r.index,
      audioDataUrl: `data:audio/wav;base64,${r.wavBuffer.toString("base64")}`,
      mimeType: r.mimeType,
      bytes: r.bytes,
    }));
    return NextResponse.json({ items });
  } catch (err) {
    if (err instanceof GeminiTtsError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode ?? 500 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tts/generate]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
