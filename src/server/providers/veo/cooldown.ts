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
 * last entry (so escalation caps at ~1 minute instead of growing forever).
 *
 * Since the refactor that routes every request through the Chrome tab
 * that minted its reCAPTCHA token, the genuine strike rate dropped to
 * near-zero — the "huge cooldown" strategy was only needed to dig out of
 * a lockout that browser-binding now prevents. These delays are kept as
 * a last-resort safety net for a truly misbehaving account:
 *  - 10s → first blip, usually self-heals.
 *  - 20/30s → still probably transient.
 *  - 60s → Google is actually angry; stop hammering the service.
 *
 * If a user still sees strikes piling up with these values, the root
 * cause is *not* rate limiting — investigate the browser tab health
 * (clearSiteStorage / restartBrowser) instead.
 */
const STRIKE_DELAYS_MS = [s(10), s(20), s(30), s(60)];

/**
 * If no new strike happens for this long, reset the escalation counter. We
 * want a persistent spam to escalate, but an isolated blip shouldn't
 * permanently move the user into the "high punishment" bucket.
 */
const STRIKE_RESET_MS = s(10 * 60);

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
