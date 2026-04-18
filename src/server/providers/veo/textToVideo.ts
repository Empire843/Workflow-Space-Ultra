import { randomUUID } from "node:crypto";

import {
  clampSeed,
  DEFAULT_SEED,
  PAYGATE_TIER_FOR_ACCOUNT,
  URL_CHECK_STATUS_VIDEO,
  URL_GENERATE_TEXT_TO_VIDEO,
  VIDEO_ASPECT_RATIO_LANDSCAPE,
  selectT2vModelKey,
} from "./constants";
import { postJsonWithToken, type HttpResult } from "./http";

/**
 * Port API_text_to_video.py
 */

export interface T2VCreateOptions {
  prompt: string;
  sessionId: string;
  projectId: string;
  recaptchaToken: string;
  accessToken: string;
  cookie?: string;
  seed?: number;
  aspectRatio?: string;
  outputCount?: number;
  modelKey?: string;
  accountType?: "NORMAL" | "PRO" | "ULTRA";
  fast2Mode?: boolean;
}

export function buildT2VPayload(opts: T2VCreateOptions) {
  const {
    prompt,
    sessionId,
    projectId,
    recaptchaToken,
    seed,
    aspectRatio = VIDEO_ASPECT_RATIO_LANDSCAPE,
    outputCount = 1,
    modelKey,
    accountType = "ULTRA",
    fast2Mode,
  } = opts;

  const model =
    modelKey || selectT2vModelKey({ accountType, aspectRatio, fast2Mode });
  const tier = PAYGATE_TIER_FOR_ACCOUNT[accountType] || "PAYGATE_TIER_TWO";

  const requestItemBase = {
    aspectRatio,
    seed: typeof seed === "number" ? clampSeed(seed) : DEFAULT_SEED,
    textInput: { prompt },
    videoModelKey: model,
    metadata: { sceneId: randomUUID() },
  };

  const count = outputCount > 0 ? outputCount : 1;
  const requests = Array.from({ length: count }, () => ({
    ...requestItemBase,
    metadata: { sceneId: randomUUID() },
  }));

  return {
    clientContext: {
      recaptchaContext: {
        token: recaptchaToken,
        applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
      },
      sessionId,
      projectId,
      tool: "PINHOLE",
      userPaygateTier: tier,
    },
    requests,
  };
}

export interface OperationRef {
  name: string;
  sceneId: string;
}

export function parseOperationsFromCreateResponse(body: string): OperationRef[] {
  try {
    const parsed = JSON.parse(body) as {
      operations?: Array<{ operation?: { name?: string }; sceneId?: string }>;
    };
    const ops = parsed.operations || [];
    const out: OperationRef[] = [];
    for (const o of ops) {
      const name = o.operation?.name;
      const sceneId = o.sceneId;
      if (name && sceneId) out.push({ name, sceneId });
    }
    return out;
  } catch {
    return [];
  }
}

export async function requestCreateT2V(opts: T2VCreateOptions): Promise<HttpResult> {
  const payload = buildT2VPayload(opts);
  return postJsonWithToken(URL_GENERATE_TEXT_TO_VIDEO, payload, opts.accessToken, opts.cookie);
}

export interface StatusEntry {
  sceneId: string;
  status?: string;
  videoUrl?: string;
  progressPercent?: number;
  raw?: unknown;
}

export async function requestCheckStatus(
  operations: OperationRef[],
  accessToken: string,
  sessionId: string,
  cookie?: string
): Promise<{ http: HttpResult; entries: StatusEntry[] }> {
  const payload = {
    operations: operations.map((o) => ({
      operation: { name: o.name },
      sceneId: o.sceneId,
    })),
    clientContext: { sessionId, tool: "PINHOLE" },
  };
  const http = await postJsonWithToken(URL_CHECK_STATUS_VIDEO, payload, accessToken, cookie);
  const entries: StatusEntry[] = [];
  if (http.ok) {
    try {
      const body = JSON.parse(http.body) as {
        operations?: Array<{
          operation?: {
            name?: string;
            done?: boolean;
            metadata?: {
              progressPercent?: number;
              status?: string;
              video?: { uri?: string; downloadUrl?: string; fifeUrl?: string };
            };
            response?: {
              videos?: Array<{ downloadUrl?: string; uri?: string; fifeUrl?: string }>;
            };
          };
          sceneId?: string;
          status?: string;
        }>;
      };
      const ops = body.operations || [];
      for (const o of ops) {
        const sceneId = o.sceneId || "";
        const status = o.status || o.operation?.metadata?.status || "";
        const progressPercent = o.operation?.metadata?.progressPercent;
        const videoUrl =
          o.operation?.response?.videos?.[0]?.downloadUrl ||
          o.operation?.response?.videos?.[0]?.uri ||
          o.operation?.response?.videos?.[0]?.fifeUrl ||
          o.operation?.metadata?.video?.downloadUrl ||
          o.operation?.metadata?.video?.uri ||
          o.operation?.metadata?.video?.fifeUrl;
        entries.push({
          sceneId,
          status,
          progressPercent,
          videoUrl: videoUrl || undefined,
          raw: o,
        });
      }
    } catch {
      // ignore
    }
  }
  return { http, entries };
}
