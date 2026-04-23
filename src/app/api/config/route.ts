import { NextResponse } from "next/server";

import { SaveConfigSchema, type ClientSettings } from "@/lib/schemas/api";
import { loadConfig, saveConfig } from "@/server/config";
import { parseJsonBody } from "@/server/http/validate";
import { setLaneConcurrency } from "@/server/lanes";

export const runtime = "nodejs";

export async function GET() {
  const c = loadConfig();
  const settings: ClientSettings = {
    accountType: c.account1.TYPE_ACCOUNT,
    veoProjectId: c.account1.projectId || "",
    veoSessionId: c.account1.sessionId || "",
    createImageModel: c.CREATE_IMAGE_MODEL || "Nano Banana 2",
    seedMode: c.SEED_MODE || "Random",
    seedValue: c.SEED_VALUE ?? 9797,
    veoConcurrency: c.VEO_CONCURRENCY ?? 1,
    grokConcurrency: c.GROK_CONCURRENCY ?? 1,
    exportDir: c.EXPORT_DIR || "",
    geminiApiKey: c.GEMINI_API_KEY || "",
    videoAnalyzerProvider: c.VIDEO_ANALYZER_PROVIDER || "gemini-api",
    geminiModel: c.GEMINI_MODEL || "gemini-2.5-flash",
    geminiTtsModel: c.GEMINI_TTS_MODEL || "gemini-3.1-flash-tts-preview",
    geminiTtsVoice: c.GEMINI_TTS_VOICE || "Kore",
    geminiTtsLanguage: c.GEMINI_TTS_LANGUAGE || "auto",
  };
  return NextResponse.json({ settings });
}

export async function POST(req: Request) {
  const result = await parseJsonBody(req, SaveConfigSchema);
  if ("response" in result) return result.response;
  const s = result.data.settings;

  const c = loadConfig();
  c.account1.TYPE_ACCOUNT = s.accountType;
  c.account1.projectId = s.veoProjectId || undefined;
  c.account1.sessionId = s.veoSessionId || undefined;
  c.CREATE_IMAGE_MODEL = s.createImageModel;
  c.SEED_MODE = s.seedMode;
  c.SEED_VALUE = s.seedValue;
  c.VEO_CONCURRENCY = s.veoConcurrency;
  c.GROK_CONCURRENCY = s.grokConcurrency;
  // Persist the chosen export directory. The POST handler intentionally does
  // not validate that the path exists — we let the user point at a folder
  // that will be mounted later. The /api/assets/export endpoint is where
  // existence / mkdir / permission checks actually bite.
  c.EXPORT_DIR = s.exportDir?.trim() || undefined;
  c.GEMINI_API_KEY = s.geminiApiKey?.trim() || undefined;
  c.VIDEO_ANALYZER_PROVIDER = s.videoAnalyzerProvider || undefined;
  c.GEMINI_MODEL = s.geminiModel || undefined;
  c.GEMINI_TTS_MODEL = s.geminiTtsModel || undefined;
  c.GEMINI_TTS_VOICE = s.geminiTtsVoice?.trim() || undefined;
  c.GEMINI_TTS_LANGUAGE = s.geminiTtsLanguage?.trim() || undefined;
  saveConfig(c);

  setLaneConcurrency("veo", s.veoConcurrency || 1);
  setLaneConcurrency("grok", s.grokConcurrency || 1);

  return NextResponse.json({ ok: true });
}
