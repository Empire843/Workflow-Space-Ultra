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
 * These values are tuned for real Google behavior observed in logs:
 *  - One or two fast strikes usually clear in ~60s.
 *  - After the third strike Google tightens the screws; 3–5 minutes is
 *    typical before a fresh token is accepted again.
 */
const STRIKE_DELAYS_MS = [s(60), s(90), s(180), s(300)];

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
 */
export async function waitForCooldown(onLog?: (msg: string) => void): Promise<void> {
  const tickMs = 5000;
  while (true) {
    const remaining = cooldownRemainingMs();
    if (remaining <= 0) return;
    const secs = Math.ceil(remaining / 1000);
    const st = getState();
    onLog?.(
      `Đang đợi Google cooldown (${secs}s còn lại, strike #${st.strikes}) — giữ tab Chrome VEO, ` +
        `đừng tắt…`,
    );
    await new Promise((r) => setTimeout(r, Math.min(tickMs, remaining)));
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
