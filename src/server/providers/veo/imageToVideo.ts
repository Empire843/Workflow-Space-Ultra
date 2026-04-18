import { randomUUID } from "node:crypto";

import {
  clampSeed,
  DEFAULT_SEED,
  IMAGE_ASPECT_RATIO_LANDSCAPE,
  PAYGATE_TIER_FOR_ACCOUNT,
  URL_GENERATE_IMAGE_TO_VIDEO,
  URL_GENERATE_IMAGE_TO_VIDEO_START_END,
  URL_UPLOAD_USER_IMAGE,
  VIDEO_ASPECT_RATIO_LANDSCAPE,
  selectI2vModelKey,
} from "./constants";
import { postJsonWithToken, type HttpResult } from "./http";

/**
 * Port of API_image_to_video.py + upload portion from SORA_API_UPLOAD_IMAGE.py
 */

export interface UploadImageOptions {
  base64Image: string;
  mimeType: string;
  sessionId: string;
  aspectRatio?: string;
  accessToken: string;
  cookie?: string;
}

export function buildUploadImagePayload(opts: UploadImageOptions) {
  return {
    imageInput: {
      rawImageBytes: opts.base64Image,
      mimeType: opts.mimeType,
      isUserUploaded: true,
      aspectRatio: opts.aspectRatio || IMAGE_ASPECT_RATIO_LANDSCAPE,
    },
    clientContext: {
      sessionId: opts.sessionId,
      tool: "ASSET_MANAGER",
    },
  };
}

export async function requestUploadUserImage(opts: UploadImageOptions): Promise<HttpResult> {
  const payload = buildUploadImagePayload(opts);
  return postJsonWithToken(URL_UPLOAD_USER_IMAGE, payload, opts.accessToken, opts.cookie);
}

export function parseUploadMediaId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      mediaId?: string;
      media?: { mediaId?: string };
      image?: { mediaId?: string };
      result?: { mediaId?: string };
    };
    return (
      parsed.mediaId ||
      parsed.media?.mediaId ||
      parsed.image?.mediaId ||
      parsed.result?.mediaId ||
      null
    );
  } catch {
    return null;
  }
}

export interface I2VCreateOptions {
  prompt: string;
  sessionId: string;
  projectId: string;
  recaptchaToken: string;
  accessToken: string;
  cookie?: string;
  seed?: number;
  aspectRatio?: string;
  startMediaId: string;
  endMediaId?: string;
  outputCount?: number;
  modelKey?: string;
  accountType?: "NORMAL" | "PRO" | "ULTRA";
  fast2Mode?: boolean;
}

export function buildI2VPayload(opts: I2VCreateOptions) {
  const {
    prompt,
    sessionId,
    projectId,
    recaptchaToken,
    seed,
    aspectRatio = VIDEO_ASPECT_RATIO_LANDSCAPE,
    startMediaId,
    endMediaId,
    outputCount = 1,
    modelKey,
    accountType = "ULTRA",
    fast2Mode,
  } = opts;

  const isStartEnd = Boolean(endMediaId);
  const model = modelKey || selectI2vModelKey({ accountType, aspectRatio, isStartEnd, fast2Mode });
  const tier = PAYGATE_TIER_FOR_ACCOUNT[accountType] || "PAYGATE_TIER_TWO";

  const requestItemBase: Record<string, unknown> = {
    aspectRatio,
    seed: typeof seed === "number" ? clampSeed(seed) : DEFAULT_SEED,
    videoModelKey: model,
    startImage: { mediaId: startMediaId },
    metadata: { sceneId: randomUUID() },
  };

  if (endMediaId) {
    requestItemBase.endImage = { mediaId: endMediaId };
    requestItemBase.textInput = {
      structuredPrompt: { parts: [{ text: String(prompt || "") }] },
    };
  } else {
    requestItemBase.textInput = { prompt };
  }

  const count = outputCount > 0 ? outputCount : 1;
  const requests = Array.from({ length: count }, () => ({
    ...requestItemBase,
    metadata: { sceneId: randomUUID() },
  }));

  return {
    clientContext: {
      recaptchaContext: { token: recaptchaToken },
      sessionId,
      projectId,
      tool: "PINHOLE",
      userPaygateTier: tier,
    },
    requests,
  };
}

export async function requestCreateI2V(opts: I2VCreateOptions): Promise<HttpResult> {
  const payload = buildI2VPayload(opts);
  const url = opts.endMediaId
    ? URL_GENERATE_IMAGE_TO_VIDEO_START_END
    : URL_GENERATE_IMAGE_TO_VIDEO;
  return postJsonWithToken(url, payload, opts.accessToken, opts.cookie);
}
