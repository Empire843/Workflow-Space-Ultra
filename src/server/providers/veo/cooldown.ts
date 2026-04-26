/**
 * Lane-wide cooldown for VEO reCAPTCHA errors (UNUSUAL_ACTIVITY).
 *
 * When Google flags an account with `PUBLIC_ERROR_UNUSUAL_ACTIVITY`, the
 * punishment is **per-account**, not per-request. Any fresh reCAPTCHA token
 * generated during the cooldown window is also rejected, even if the code
 * path is completely separate. Retrying aggressively just refreshes the
 * timer and keeps the user locked out.
 *
 * To handle this correctly we need state that every in-flight VEO caller
 * can see — not a per-request backoff. This module keeps a single
 * `untilMs` timestamp on `globalThis` so the whole server process (across
 * HMR reloads, across different provider helpers) shares one cooldown.
 *
 * Escalation: repeat strikes within a short window mean the account has
 * already been rate-limited and Google is watching closely. Each strike
 * extends the cooldown more aggressively so we stop hammering the service.
 */

interface CooldownState {
  /** Unix ms when the cooldown ends. 0 = no cooldown. */
  untilMs: number;
  /** Number of UNUSUAL_ACTIVITY strikes in the current escalation window. */
  strikes: number;
  /** When the current strike count was last incremented. */
  lastStrikeMs: number;
}

const GLOBAL_KEY = "__wsu_veo_cooldown__";

function getState(): CooldownState {
  const g = globalThis as unknown as Record<string, CooldownState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { untilMs: 0, strikes: 0, lastStrikeMs: 0 };
  return g[GLOBAL_KEY]!;
}

/** Seconds → milliseconds. */
const s = (n: number) => n * 1000;

/**
 * How long to wait after each strike, in order. Beyond the list, reuse the
 * last entry (so escalation caps at ~5 minutes instead of growing forever).
 *
 * Tuned after observing real PUBLIC_ERROR_UNUSUAL_ACTIVITY storms: once
 * Google trips the flag, follow-up requests come back 403 for ~30-60s and
 * then the account transitions into a "silent blackhole" mode where POSTs
 * just time out at 60s. That second stage only clears when the account
 * sits idle for 3-5 minutes. Short cooldowns let us dig deeper into the
 * pit instead of climbing out.
 *  - 30s → first blip; plenty for Google's short-window counter to reset.
 *  - 60s → second strike in a row means the short-window reset wasn't
 *          enough; let a little more time pass.
 *  - 120s / 240s / 300s → account is clearly being watched; stop poking.
 */
const STRIKE_DELAYS_MS = [s(30), s(30), s(30), s(30), s(60)];

/**
 * If no new strike happens for this long, reset the escalation counter. We
 * want a persistent spam to escalate, but an isolated blip shouldn't
 * permanently move the user into the "high punishment" bucket.
 */
const STRIKE_RESET_MS = s(10 * 60);

/**
 * Debounce window: concurrent callers that all hit the same 403 should
 * count as ONE strike, not N. Without this, 4 parallel `gen.image` jobs
 * each reporting a 403 within the same tick would bump `strikes` to 4
 * and immediately push the cooldown to the 240s tier — punishing the
 * user for parallelism the UI promised them.
 */
const STRIKE_DEBOUNCE_MS = s(3);

/** Record an UNUSUAL_ACTIVITY hit. Returns when the cooldown will end. */
export function recordRecaptchaStrike(now: number = Date.now()): {
  untilMs: number;
  strikes: number;
  delayMs: number;
} {
  const st = getState();
  if (now - st.lastStrikeMs > STRIKE_RESET_MS) {
    st.strikes = 0;
  }
  // Debounce concurrent 403s from the same burst. When the last strike is
  // fresh AND we still have cooldown time remaining, treat this report as
  // the same event: extend nothing, no increment. Only a strike that
  // arrives AFTER the previous cooldown expired (meaning we tried again
  // and Google rejected again) counts as a NEW strike.
  const sinceLast = now - st.lastStrikeMs;
  const stillCooling = st.untilMs > now;
  if (st.strikes > 0 && sinceLast < STRIKE_DEBOUNCE_MS && stillCooling) {
    const delay =
      STRIKE_DELAYS_MS[Math.min(st.strikes - 1, STRIKE_DELAYS_MS.length - 1)];
    return { untilMs: st.untilMs, strikes: st.strikes, delayMs: delay };
  }
  st.strikes = Math.min(st.strikes + 1, 999);
  st.lastStrikeMs = now;
  const delay = STRIKE_DELAYS_MS[Math.min(st.strikes - 1, STRIKE_DELAYS_MS.length - 1)];
  // Extend, never shorten — if a later job already set a longer cooldown we
  // keep that.
  st.untilMs = Math.max(st.untilMs, now + delay);
  return { untilMs: st.untilMs, strikes: st.strikes, delayMs: delay };
}

/** Remaining cooldown in ms (0 if none). */
export function cooldownRemainingMs(now: number = Date.now()): number {
  const st = getState();
  return Math.max(0, st.untilMs - now);
}

/**
 * Block until the cooldown is cleared. Emits progress updates every ~5s
 * via `onLog` so the UI can show a countdown instead of appearing frozen.
 *
 * `shouldCancel` is polled between ticks so a cancelled job unwinds in
 * <= 200ms instead of sitting through the full 10-60s punishment window.
 */
import { ensureNotCancelled, type ShouldCancel } from "../cancellation";

export async function waitForCooldown(
  onLog?: (msg: string) => void,
  shouldCancel?: ShouldCancel,
): Promise<void> {
  const tickMs = 5000;
  const pollMs = 200;
  let lastRecoverMs = 0;

  while (true) {
    ensureNotCancelled(shouldCancel);
    const remaining = cooldownRemainingMs();
    if (remaining <= 0) return;
    const secs = Math.ceil(remaining / 1000);
    const st = getState();
    onLog?.(
      `Đang đợi Google cooldown (${secs}s còn lại, strike #${st.strikes}) — giữ tab Chrome VEO, ` +
      `đừng tắt…`,
    );
    // Fine-grained sleep so cancel is observed ~5x per second even
    // though log emission only fires every 5s.
    const sleepBudget = Math.min(tickMs, remaining);
    const sleepDeadline = Date.now() + sleepBudget;
    while (Date.now() < sleepDeadline) {
      ensureNotCancelled(shouldCancel);
      const step = Math.min(pollMs, sleepDeadline - Date.now());
      if (step <= 0) break;
      await new Promise((r) => setTimeout(r, step));

      const now = Date.now();
      if (now - lastRecoverMs > 2000) {
        lastRecoverMs = now;
        import("../../tokens/veoTokenCollector")
          .then((m) => m.attemptRecoverLandingPage())
          .catch(() => { });
      }
    }
  }
}

/** For tests / manual reset. */
export function resetCooldown(): void {
  const st = getState();
  st.untilMs = 0;
  st.strikes = 0;
  st.lastStrikeMs = 0;
}

/** Read-only snapshot for diagnostics / APIs. */
export function getCooldownSnapshot(now: number = Date.now()) {
  const st = getState();
  return {
    strikes: st.strikes,
    lastStrikeMs: st.lastStrikeMs,
    remainingMs: Math.max(0, st.untilMs - now),
    untilMs: st.untilMs,
  };
}
