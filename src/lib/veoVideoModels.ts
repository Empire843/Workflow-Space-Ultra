/**
 * List of VEO video models shown in the UI + helper to map label → raw modelKey
 * by aspect ratio (landscape/portrait) + start-end flag.
 *
 * Raw keys are kept in sync with `T2V_MODEL_KEYS` / `I2V_MODEL_KEYS` in
 * src/server/providers/veo/constants.ts — if Google changes a key, update both files.
 *
 * Credits: cross-check with Flow web. Update `credits` whenever Google changes pricing.
 * "Relaxed" == the "Lower Priority" tier in the Flow UI — free (0 cr) for Ultra subscribers,
 * waits longer for a slot than Fast.
 */

export interface VeoVideoModelOption {
  label: string;
  /** Landscape / portrait key for aspect 16:9 or 1:1. */
  keyLandscape: string;
  /** Portrait key for aspect 9:16. */
  keyPortrait: string;
  /** Only used for I2V Start+End frame (portrait). When undefined, falls back to keyPortrait. */
  keyPortraitFL?: string;
  /**
   * Credits consumed per request (landscape/1:1).
   * TODO: update from Flow web when Google changes pricing.
   */
  credits: number;
  /**
   * Credits for portrait (9:16) if different from landscape.
   * When undefined → use shared `credits`.
   */
  creditsPortrait?: number;
}

/**
 * Order: Lower Priority (0 cr) → Ultra Fast (20 cr) → Quality (100 cr)
 * Cheapest first so users see the budget option before the expensive ones.
 */
export const VEO_T2V_MODELS: VeoVideoModelOption[] = [
  {
    // "Relaxed" in constants.ts = "Lower Priority" in the Flow UI — 0 credits
    label: "VEO 3.1 Ultra (Lower Priority)",
    keyLandscape: "veo_3_1_t2v_fast_ultra_relaxed",
    keyPortrait: "veo_3_1_t2v_fast_portrait_ultra_relaxed",
    credits: 0,
  },
  {
    label: "VEO 3.1 Ultra (Fast)",
    keyLandscape: "veo_3_1_t2v_fast_ultra",
    keyPortrait: "veo_3_1_t2v_fast_portrait_ultra",
    credits: 20,
  },
  {
    label: "VEO 3.1 Quality",
    keyLandscape: "veo_3_1_t2v_fast",
    keyPortrait: "veo_3_1_t2v_fast_portrait",
    credits: 100,
  },
];

export const VEO_I2V_MODELS: VeoVideoModelOption[] = [
  {
    label: "VEO 3.1 Ultra (Lower Priority)",
    keyLandscape: "veo_3_1_i2v_s_fast_ultra_relaxed",
    keyPortrait: "veo_3_1_i2v_s_fast_portrait_ultra_relaxed",
    keyPortraitFL: "veo_3_1_i2v_s_fast_portrait_fl_ultra_relaxed",
    credits: 0,
  },
  {
    label: "VEO 3.1 Ultra (Fast)",
    keyLandscape: "veo_3_1_i2v_s_fast_ultra",
    keyPortrait: "veo_3_1_i2v_s_fast_portrait_ultra",
    keyPortraitFL: "veo_3_1_i2v_s_fast_portrait_fl_ultra",
    credits: 20,
  },
  {
    label: "VEO 3.1 Quality",
    keyLandscape: "veo_3_1_i2v_s_fast",
    keyPortrait: "veo_3_1_i2v_s_fast_portrait",
    keyPortraitFL: "veo_3_1_i2v_s_fast_portrait_fl",
    credits: 100,
  },
];

/** Default = Ultra Fast (20 cr, not Lower Priority so users don't accidentally wait forever). */
export const VEO_T2V_DEFAULT_LABEL = "VEO 3.1 Ultra (Fast)";
export const VEO_I2V_DEFAULT_LABEL = "VEO 3.1 Ultra (Fast)";

/**
 * Get the credit cost for the given label + selected aspect.
 * Returns -1 if the label isn't found (caller decides how to handle).
 */
export function getCreditsFor(
  models: VeoVideoModelOption[],
  label: string | undefined,
  aspectUI: string | undefined
): number {
  const opt = models.find((m) => m.label === label);
  if (!opt) return -1;
  if (aspectUI === "9:16" && opt.creditsPortrait !== undefined) {
    return opt.creditsPortrait;
  }
  return opt.credits;
}

/**
 * Resolve modelKey from label + aspect ratio + start-end flag.
 * If the label doesn't match (e.g. legacy label / not set) → returns undefined; caller should
 * fall back to the legacy `selectT2vModelKey` / `selectI2vModelKey`.
 */
export function resolveT2vModelKey(label: string | undefined, aspectUI: string | undefined): string | undefined {
  const opt = VEO_T2V_MODELS.find((m) => m.label === label);
  if (!opt) return undefined;
  return aspectUI === "9:16" ? opt.keyPortrait : opt.keyLandscape;
}

export function resolveI2vModelKey(
  label: string | undefined,
  aspectUI: string | undefined,
  isStartEnd: boolean
): string | undefined {
  const opt = VEO_I2V_MODELS.find((m) => m.label === label);
  if (!opt) return undefined;
  const portrait = aspectUI === "9:16";
  if (isStartEnd && portrait) {
    return opt.keyPortraitFL || opt.keyPortrait;
  }
  return portrait ? opt.keyPortrait : opt.keyLandscape;
}
