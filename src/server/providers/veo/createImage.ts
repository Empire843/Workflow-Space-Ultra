import { randomUUID } from "node:crypto";

import type { Page } from "playwright";

import {
  clampSeed,
  CREATE_IMAGE_MODEL_TO_KEY,
  IMAGE_ASPECT_RATIO_LANDSCAPE,
  SEED_MAX,
  URL_GENERATE_IMAGES_TEMPLATE,
} from "./constants";
import { postJsonViaBrowser, postJsonWithToken, type HttpResult } from "./http";

/**
 * Port of API_Create_image.py - calls flowMedia:batchGenerateImages for Nano Banana / Imagen.
 *
 * Payload schema (from the Python template):
 *   {
 *     clientContext: { recaptchaContext, sessionId, projectId, tool: "PINHOLE" },
 *     requests: [
 *       {
 *         clientContext: {...same...},   // NESTED again inside each request item
 *         imageAspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
 *         seed: <int>,
 *         imageModelName: "NARWHAL" | "IMAGEN_3_5" | ...,
 *         prompt: "...",
 *         imageInputs: []
 *       }
 *     ]
 *   }
 *
 * NOTE: the field is `imageAspectRatio` (not aspectRatio), `imageModelName` (not
 * imageModelKey/modelKey), `prompt` (not textInput). There is NO metadata.sceneId.
 */

/**
 * A reference / subject image for Nano Banana / edit-capable models.
 *
 * Schema source: useapi.net Flow docs (reverse-engineered). The batchGenerateImages
 * endpoint accepts per-request `imageInputs: [{ mediaGenerationId, imageInputType }]`.
 * `mediaGenerationId` is the flat string returned by `uploadUserImage`.
 * `imageInputType` enum: "IMAGE_INPUT_TYPE_REFERENCE" (default here).
 */
export interface ReferenceImageInput {
  mediaGenerationId: string;
  /** Role enum — full protobuf name e.g. "IMAGE_INPUT_TYPE_REFERENCE". */
  imageInputType?: string;
}

export interface CreateImageOptions {
  prompt: string;
  sessionId: string;
  projectId: string;
  recaptchaToken: string;
  accessToken: string;
  cookie?: string;
  modelLabel?: string; // VD: "Nano Banana 2"
  imageModelKey?: string;
  aspectRatio?: string;
  outputCount?: number;
  accountType?: "NORMAL" | "PRO" | "ULTRA";
  seed?: number;
  /** Upstream reference images (Nano Banana). Ignored by pure T2I models. */
  referenceImages?: ReferenceImageInput[];
}

/** Models that accept `imageInputs` (reference / edit). Imagen is pure T2I. */
export const MODEL_SUPPORTS_REFERENCE: Record<string, boolean> = {
  NARWHAL: true,      // Nano Banana 2
  GEM_PIX_2: true,    // Nano Banana pro
  GEM_PIX: true,      // Nano Banana (legacy)
  IMAGEN_3_5: false,  // Imagen 4 — text-only
};

function randomSeed(): number {
  return Math.floor(Math.random() * (SEED_MAX + 1));
}

export function buildCreateImagePayload(opts: CreateImageOptions) {
  const {
    prompt,
    sessionId,
    projectId,
    recaptchaToken,
    modelLabel = "Nano Banana 2",
    imageModelKey,
    aspectRatio = IMAGE_ASPECT_RATIO_LANDSCAPE,
    outputCount = 1,
    seed,
  } = opts;

  const modelName = imageModelKey || CREATE_IMAGE_MODEL_TO_KEY[modelLabel] || "NARWHAL";

  const clientContext = {
    recaptchaContext: {
      token: recaptchaToken,
      applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
    },
    sessionId,
    projectId,
    tool: "PINHOLE",
  };

  // Schema confirmed from captured labs.google UI payload (VEO_CAPTURE_PAYLOADS=1):
  //   top-level:   clientContext, mediaGenerationContext.batchId, useNewMedia, requests[]
  //   per-request: clientContext, imageModelName, imageAspectRatio,
  //                structuredPrompt.parts[].text, seed, imageInputs[]
  //   imageInputs[i]: { imageInputType: "IMAGE_INPUT_TYPE_REFERENCE", name: <uuid> }
  //
  // `name` is the plain UUID identifier of a previously-seen Flow media asset
  // (returned by both `batchGenerateImages` responses — under `name`/`mediaId` —
  // and `uploadUserImage` responses — nested under `mediaGenerationId`).
  //
  // Rejected shapes (do NOT bring these back without re-capturing a new UI payload):
  //   top-of-request:      imageGenerationRequestData | requestData | imageGenerationImageInputs
  //   imageInputs[0].<x>:  mediaId | mediaGenerationId | mimeType | imageRole
  //                         | image | generatedImage
  const supportsRef = MODEL_SUPPORTS_REFERENCE[modelName] ?? false;
  const refs = opts.referenceImages ?? [];
  const referenceItems = supportsRef
    ? refs.map((r) => ({
        imageInputType: r.imageInputType || "IMAGE_INPUT_TYPE_REFERENCE",
        name: r.mediaGenerationId,
      }))
    : [];

  const count = outputCount > 0 ? outputCount : 1;
  const requests = Array.from({ length: count }, (_, i) => {
    let effectiveSeed: number;
    if (typeof seed === "number") {
      effectiveSeed = clampSeed(seed + i);
    } else {
      effectiveSeed = randomSeed();
    }

    const requestItem: Record<string, unknown> = {
      clientContext: JSON.parse(JSON.stringify(clientContext)),
      imageModelName: modelName,
      imageAspectRatio: aspectRatio,
      // Real UI: structuredPrompt preferred; flat `prompt` is legacy.
      structuredPrompt: { parts: [{ text: prompt || "" }] },
      seed: effectiveSeed,
      imageInputs: JSON.parse(JSON.stringify(referenceItems)),
    };
    return requestItem;
  });

  return {
    clientContext,
    // One batchId per call (UUID); `useNewMedia: true` is always set by UI.
    mediaGenerationContext: { batchId: randomUUID() },
    useNewMedia: true,
    requests,
  };
}

export async function requestCreateImage(opts: CreateImageOptions): Promise<HttpResult> {
  const url = URL_GENERATE_IMAGES_TEMPLATE.replace("{projectId}", opts.projectId);
  const payload = buildCreateImagePayload(opts);
  return postJsonWithToken(url, payload, opts.accessToken, opts.cookie);
}

/**
 * Browser-routed create-image call. Must be invoked with the Page from
 * `VeoTokenCollector.getPageForMode("image")` so the request fingerprint
 * matches the token embedded in `opts.recaptchaToken`.
 */
export async function requestCreateImageViaBrowser(
  page: Page,
  opts: CreateImageOptions,
): Promise<HttpResult> {
  const url = URL_GENERATE_IMAGES_TEMPLATE.replace("{projectId}", opts.projectId);
  const payload = buildCreateImagePayload(opts);
  return postJsonViaBrowser(page, url, payload, opts.accessToken);
}

export interface GeneratedImage {
  mediaId?: string;
  imageUrl?: string;
  rawBytes?: string;
  mimeType?: string;
}

/**
 * Recursive crawl like parse_media_from_response (Python) — find every node with
 * downloadUrl / uri / fifeUrl at any depth.
 */
export function parseGeneratedImages(body: string): GeneratedImage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }

  const out: GeneratedImage[] = [];
  const visit = (node: unknown) => {
    if (node && typeof node === "object") {
      if (!Array.isArray(node)) {
        const obj = node as Record<string, unknown>;
        const url =
          (obj.downloadUrl as string | undefined) ||
          (obj.uri as string | undefined) ||
          (obj.fifeUrl as string | undefined);
        if (typeof url === "string") {
          out.push({
            mediaId:
              (obj.mediaId as string | undefined) ||
              (obj.mediaGenerationId as string | undefined) ||
              (obj.name as string | undefined),
            imageUrl: url,
            mimeType: obj.mimeType as string | undefined,
          });
        }
        // Also check encoded bytes (the API sometimes returns base64 instead of a URL)
        const raw =
          (obj.encodedImage as string | undefined) ||
          (obj.encodedImageJpeg as string | undefined) ||
          (obj.imageBytes as string | undefined);
        if (raw && !url) {
          out.push({
            mediaId: obj.mediaId as string | undefined,
            rawBytes: raw,
            mimeType: (obj.mimeType as string | undefined) || "image/png",
          });
        }
        for (const v of Object.values(obj)) visit(v);
      } else {
        for (const v of node) visit(v);
      }
    }
  };
  visit(parsed);
  return out;
}
