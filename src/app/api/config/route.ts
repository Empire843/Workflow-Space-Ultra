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
  saveConfig(c);

  setLaneConcurrency("veo", s.veoConcurrency || 1);
  setLaneConcurrency("grok", s.grokConcurrency || 1);

  return NextResponse.json({ ok: true });
}
