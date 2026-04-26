import type { VeoTokenCollector } from "../../tokens/veoTokenCollector";
import { cancelableSleep, raceCancel, type ShouldCancel } from "../cancellation";

/**
 * Shared helpers for VEO Strike Prevention Hardening (plan: periodic proactive
 * clear + human-pause jitter). Extracted to a standalone module so both the
 * direct `withRecaptcha` path (in `./index.ts`) and the batched path (in
 * `./batcher.ts`) can call into them without creating an import cycle between
 * those two files.
 *
 * ## Env vars consumed
 *   - `VEO_CLEAR_STORAGE_EVERY` (default 6, 0 disables)
 *       Number of successful captures per mode before we proactively wipe
 *       site storage. Mirrors `CLEAR_DATA_EVERY` from the Python reference
 *       (`A_workflow_text_to_video.py`), which resets Google's per-origin
 *       abuse counter before it reaches the 403 threshold.
 *   - `VEO_PRECAPTURE_JITTER_MIN_MS` (default 300)
 *   - `VEO_PRECAPTURE_JITTER_MAX_MS` (default 1000)
 *       Random pause right before we trigger the Flow "Tạo" button. Real
 *       humans don't fire N back-to-back generations on a sub-20s beat;
 *       300–1000ms of last-moment hesitation is just enough to scuff the
 *       timing fingerprint without adding perceptible latency.
 */

type Mode = "video" | "image";

interface CaptureCounterState {
  image: number;
  video: number;
}

/**
 * Counter lives on `globalThis` so it survives Next.js HMR module reloads
 * in dev (same pattern as the collector singleton). In production it's
 * just a module-global behind `globalThis` — identical semantics.
 */
function getCaptureCounter(): CaptureCounterState {
  const g = globalThis as unknown as Record<string, CaptureCounterState | undefined>;
  const KEY = "__wsu_veo_capture_count__";
  if (!g[KEY]) g[KEY] = { image: 0, video: 0 };
  return g[KEY]!;
}

const VEO_CLEAR_EVERY_DEFAULT = 4;
export function readClearEvery(): number {
  const raw = Number(process.env.VEO_CLEAR_STORAGE_EVERY);
  if (!Number.isFinite(raw)) return VEO_CLEAR_EVERY_DEFAULT;
  if (raw < 0) return 0; // negative values disable the feature entirely
  return Math.floor(raw);
}

/**
 * Test helper: reset the global counter between cases so each test
 * starts from a clean slate without needing `jest.isolateModules`.
 * Safe to export in production — it only resets bookkeeping.
 */
export function __resetCaptureCounterForTests(): void {
  const counter = getCaptureCounter();
  counter.image = 0;
  counter.video = 0;
}

/**
 * Increment the per-mode capture counter. Return `true` when the new
 * value has landed on a `VEO_CLEAR_STORAGE_EVERY` boundary and the
 * caller should perform a proactive clear. The counter never rolls back
 * — even if the clear itself throws, a subsequent capture should
 * continue counting from where we left off rather than re-attempting
 * the clear immediately.
 */
export function shouldTriggerProactiveClear(mode: Mode): { counter: number; clear: boolean } {
  const counter = getCaptureCounter();
  counter[mode] = (counter[mode] ?? 0) + 1;
  const every = readClearEvery();
  return {
    counter: counter[mode],
    clear: every > 0 && counter[mode] % every === 0,
  };
}

/**
 * Combined helper used by both the direct and batched paths.
 * Increments the counter and, when on a clear boundary, calls
 * `collector.clearSiteStorage(mode)` inline. Failures are logged but
 * never thrown — a broken clear must not take out an otherwise
 * healthy request.
 */
export async function bumpAndMaybeClear(
  collector: VeoTokenCollector,
  mode: Mode,
  onLog?: (msg: string) => void,
  shouldCancel?: ShouldCancel,
): Promise<number> {
  const { counter, clear } = shouldTriggerProactiveClear(mode);
  if (!clear) return counter;
  const every = readClearEvery();
  onLog?.(
    `Proactive storage clear (capture #${counter} mode=${mode}, every ${every}) để giữ reCAPTCHA score…`,
  );
  try {
    await raceCancel(collector.clearSiteStorage(mode), shouldCancel);
  } catch (err) {
    onLog?.(
      `Proactive clear failed (non-fatal): ${err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120)
      }`,
    );
  }
  return counter;
}

/**
 * Human-pause jitter (300-1000ms by default) before a capture trigger.
 * Skipped entirely when both env vars clamp to 0.
 */
export async function preCaptureJitter(shouldCancel?: ShouldCancel): Promise<void> {
  const min = Number(process.env.VEO_PRECAPTURE_JITTER_MIN_MS);
  const max = Number(process.env.VEO_PRECAPTURE_JITTER_MAX_MS);
  const lo = Number.isFinite(min) && min >= 0 ? min : 300;
  const hi = Number.isFinite(max) && max >= lo ? max : 1_000;
  if (hi === 0) return;
  const delay = Math.floor(lo + Math.random() * (hi - lo));
  if (delay > 0) await cancelableSleep(delay, shouldCancel);
}
