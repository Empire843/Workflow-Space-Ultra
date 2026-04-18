/**
 * Constants for the VEO API (ported from API_text_to_video.py, API_image_to_video.py, API_Create_image.py)
 *
 * WARNING: model keys and endpoints may change when Google updates Flow.
 * Keep this file separate so it can be updated quickly without a redeploy.
 */

export const URL_GENERATE_TEXT_TO_VIDEO =
  "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText";
export const URL_GENERATE_IMAGE_TO_VIDEO =
  "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage";
export const URL_GENERATE_IMAGE_TO_VIDEO_START_END =
  "https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage";
export const URL_CHECK_STATUS_VIDEO =
  "https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus";
export const URL_UPLOAD_USER_IMAGE = "https://aisandbox-pa.googleapis.com/v1:uploadUserImage";
export const URL_GENERATE_IMAGES_TEMPLATE =
  "https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:batchGenerateImages";

export const VIDEO_ASPECT_RATIO_LANDSCAPE = "VIDEO_ASPECT_RATIO_LANDSCAPE";
export const VIDEO_ASPECT_RATIO_PORTRAIT = "VIDEO_ASPECT_RATIO_PORTRAIT";
export const IMAGE_ASPECT_RATIO_LANDSCAPE = "IMAGE_ASPECT_RATIO_LANDSCAPE";
export const IMAGE_ASPECT_RATIO_PORTRAIT = "IMAGE_ASPECT_RATIO_PORTRAIT";
export const IMAGE_ASPECT_RATIO_SQUARE = "IMAGE_ASPECT_RATIO_SQUARE";

export const DEFAULT_SEED = 9797;
export const SEED_MAX = 294967295;

export function clampSeed(v: number): number {
  return ((v % (SEED_MAX + 1)) + (SEED_MAX + 1)) % (SEED_MAX + 1);
}

export const PAYGATE_TIER_FOR_ACCOUNT: Record<string, string> = {
  NORMAL: "PAYGATE_TIER_NOT_PAID",
  PRO: "PAYGATE_TIER_ONE",
  ULTRA: "PAYGATE_TIER_TWO",
};

// ====== Text-to-Video model keys ======
export const T2V_MODEL_KEYS = {
  ULTRA: "veo_3_1_t2v_fast_ultra",
  ULTRA_PORTRAIT: "veo_3_1_t2v_fast_portrait_ultra",
  ULTRA_RELAXED: "veo_3_1_t2v_fast_ultra_relaxed",
  ULTRA_PORTRAIT_RELAXED: "veo_3_1_t2v_fast_portrait_ultra_relaxed",
  NORMAL: "veo_3_1_t2v_fast",
  NORMAL_PORTRAIT: "veo_3_1_t2v_fast_portrait",
} as const;

// ====== Image-to-Video model keys ======
export const I2V_MODEL_KEYS = {
  ULTRA: "veo_3_1_i2v_s_fast_ultra",
  ULTRA_PORTRAIT: "veo_3_1_i2v_s_fast_portrait_ultra",
  ULTRA_RELAXED: "veo_3_1_i2v_s_fast_ultra_relaxed",
  ULTRA_PORTRAIT_RELAXED: "veo_3_1_i2v_s_fast_portrait_ultra_relaxed",
  ULTRA_PORTRAIT_FL: "veo_3_1_i2v_s_fast_portrait_fl_ultra",
  ULTRA_PORTRAIT_FL_RELAXED: "veo_3_1_i2v_s_fast_portrait_fl_ultra_relaxed",
  NORMAL: "veo_3_1_i2v_s_fast",
  NORMAL_PORTRAIT: "veo_3_1_i2v_s_fast_portrait",
  NORMAL_PORTRAIT_FL: "veo_3_1_i2v_s_fast_portrait_fl",
} as const;

// ====== Create Image model keys (Nano Banana / Imagen) ======
export const CREATE_IMAGE_MODEL_TO_KEY: Record<string, string> = {
  "Nano Banana pro": "GEM_PIX_2",
  "Nano Banana 2": "NARWHAL",
  "Nano Banana": "GEM_PIX",
  "Imagen 4": "IMAGEN_3_5",
};

export function selectT2vModelKey(params: {
  accountType: "NORMAL" | "PRO" | "ULTRA";
  aspectRatio: string;
  fast2Mode?: boolean;
}): string {
  const { accountType, aspectRatio, fast2Mode } = params;
  const portrait = aspectRatio === VIDEO_ASPECT_RATIO_PORTRAIT;

  if (accountType === "ULTRA") {
    if (fast2Mode) {
      return portrait ? T2V_MODEL_KEYS.ULTRA_PORTRAIT_RELAXED : T2V_MODEL_KEYS.ULTRA_RELAXED;
    }
    return portrait ? T2V_MODEL_KEYS.ULTRA_PORTRAIT : T2V_MODEL_KEYS.ULTRA;
  }

  // NORMAL & PRO
  return portrait ? T2V_MODEL_KEYS.NORMAL_PORTRAIT : T2V_MODEL_KEYS.NORMAL;
}

export function selectI2vModelKey(params: {
  accountType: "NORMAL" | "PRO" | "ULTRA";
  aspectRatio: string;
  isStartEnd?: boolean;
  fast2Mode?: boolean;
}): string {
  const { accountType, aspectRatio, isStartEnd, fast2Mode } = params;
  const portrait = aspectRatio === VIDEO_ASPECT_RATIO_PORTRAIT;

  if (isStartEnd && portrait) {
    if (accountType === "ULTRA") {
      return fast2Mode
        ? I2V_MODEL_KEYS.ULTRA_PORTRAIT_FL_RELAXED
        : I2V_MODEL_KEYS.ULTRA_PORTRAIT_FL;
    }
    return I2V_MODEL_KEYS.NORMAL_PORTRAIT_FL;
  }

  if (accountType === "ULTRA") {
    if (fast2Mode) {
      return portrait ? I2V_MODEL_KEYS.ULTRA_PORTRAIT_RELAXED : I2V_MODEL_KEYS.ULTRA_RELAXED;
    }
    return portrait ? I2V_MODEL_KEYS.ULTRA_PORTRAIT : I2V_MODEL_KEYS.ULTRA;
  }

  return portrait ? I2V_MODEL_KEYS.NORMAL_PORTRAIT : I2V_MODEL_KEYS.NORMAL;
}
