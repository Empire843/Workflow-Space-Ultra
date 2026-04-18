import {
  clampSeed,
  CREATE_IMAGE_MODEL_TO_KEY,
  IMAGE_ASPECT_RATIO_LANDSCAPE,
  SEED_MAX,
  URL_GENERATE_IMAGES_TEMPLATE,
} from "./constants";
import { postJsonWithToken, type HttpResult } from "./http";

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
}

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

  const count = outputCount > 0 ? outputCount : 1;
  const requests = Array.from({ length: count }, (_, i) => {
    let effectiveSeed: number;
    if (typeof seed === "number") {
      effectiveSeed = clampSeed(seed + i);
    } else {
      effectiveSeed = randomSeed();
    }

    return {
      clientContext: JSON.parse(JSON.stringify(clientContext)),
      imageAspectRatio: aspectRatio,
      seed: effectiveSeed,
      imageModelName: modelName,
      prompt,
      imageInputs: [] as unknown[],
    };
  });

  return {
    clientContext,
    requests,
  };
}

export async function requestCreateImage(opts: CreateImageOptions): Promise<HttpResult> {
  const url = URL_GENERATE_IMAGES_TEMPLATE.replace("{projectId}", opts.projectId);
  const payload = buildCreateImagePayload(opts);
  return postJsonWithToken(url, payload, opts.accessToken, opts.cookie);
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
