/**
 * Session-error detection helpers.
 *
 * Purpose: when a node fails for auth/session-related reasons
 * (VEO auth collector timeout, Grok not logged in, expired token, etc.), the
 * UI shows a popup asking the user to re-login with the correct provider instead
 * of just displaying a faint error string on the node.
 */

import type { NodeDataBase, ProviderId } from "./nodes";

export type SessionProvider = Extract<ProviderId, "veo" | "grok">;

/**
 * What kind of "needs user attention" error is this?
 *
 *   "auth-expired"   — re-login is the right CTA. Token actually expired
 *                      / missing / Google rejected our credentials.
 *   "page-not-ready" — Chrome session is healthy but the Flow tab failed
 *                      to fire a recaptcha token (UI blocked, wrong
 *                      project, modal intercepted, etc.). Re-login does
 *                      NOT help; the right CTA is "Verify Now" or just
 *                      let the auto-retry loop handle it.
 */
export type SessionErrorKind = "auth-expired" | "page-not-ready";

/**
 * Regex patterns → VEO. Match messages thrown by `veoTokenCollector` /
 * `providers/veo/*` when re-login or session refresh is needed.
 */
const VEO_PATTERNS: RegExp[] = [
  /Không bắt được VEO auth/i,
  /VEO auth/i,
  /VEO session/i,
  /VEO.*(?:token|cookie|session)/i,
  /labs\.google/i,
  /Google Flow/i,
  /(?:thiếu|missing):?\s*(?:sessionId|access_token|projectId)/i,
  /Không bắt được recaptcha token/i,
  /PUBLIC_ERROR_UNUSUAL_ACTIVITY/i,
  /reCAPTCHA evaluation failed/i,
];

/**
 * Subset of VEO_PATTERNS that mean "the Chrome / page is wedged" — NOT
 * "credentials are expired". When matched we keep the popup but switch
 * its CTA from "Login" to "Verify Now / Reload Tab" so we don't tell the
 * user to re-login when they're already perfectly logged in.
 */
const PAGE_NOT_READY_PATTERNS: RegExp[] = [
  /Không bắt được recaptcha token/i,
  /Target (?:page, context or browser )?(?:has been )?closed/i,
  /page has been closed/i,
];

/**
 * Regex patterns → Grok.
 */
const GROK_PATTERNS: RegExp[] = [
  /Không bắt được Grok/i,
  /Grok page not ready/i,
  /Grok page\.evaluate timeout/i,
  /Grok statsig/i,
  /chưa login Grok/i,
  /Grok.*(?:login|session|cookie|statsig)/i,
  /grok\.com/i,
  /x-statsig-id/i,
  /(?:chưa login|session hết hạn).*Chrome Grok/i,
];

/**
 * Generic "need re-auth" patterns — cannot determine the provider themselves, so the
 * caller must fall back to `providerOfNode()`.
 */
const GENERIC_AUTH_PATTERNS: RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /UNAUTHENTICATED/i,
  /unauthorized/i,
  /not (?:logged in|signed in)/i,
  /token (?:expired|invalid)/i,
  /session (?:expired|invalid)/i,
];

/**
 * Map a NodeDataBase → the provider responsible for the API call.
 *
 * - `gen.image` → genMode (t2i.veo) → veo
 * - `gen.video` → genMode (t2v.veo / i2v.veo / t2v.grok / i2v.grok)
 * - `gen.start-end` → veo
 * - `xform.upscale.grok` → grok
 *
 * Returns `null` for content nodes / local xforms (no re-login needed).
 */
export function providerOfNode(data: NodeDataBase): SessionProvider | null {
  const kind = data.kind;
  const mode = data.genMode;

  if (kind === "gen.start-end") return "veo";
  if (kind === "xform.upscale.grok") return "grok";
  if (kind === "gen.image") {
    if (mode?.endsWith(".grok")) return "grok";
    return "veo";
  }
  if (kind === "gen.video") {
    if (mode?.endsWith(".grok")) return "grok";
    return "veo";
  }
  return null;
}

/**
 * Detect the provider from an error message. VEO-specific pattern → "veo".
 * Grok-specific → "grok". Only generic auth → return `fallback` (the provider
 * derived from the failing node). No match → `null` (not a session error,
 * don't show the popup).
 */
export function detectSessionErrorProvider(
  message: string | undefined,
  fallback: SessionProvider | null,
): SessionProvider | null {
  if (!message) return null;
  const msg = String(message);

  for (const re of VEO_PATTERNS) if (re.test(msg)) return "veo";
  for (const re of GROK_PATTERNS) if (re.test(msg)) return "grok";
  for (const re of GENERIC_AUTH_PATTERNS) if (re.test(msg)) return fallback;

  return null;
}

/**
 * Classify an error message into a `kind` so the UI can pick the right
 * call-to-action. Default is `"auth-expired"` because the legacy popup
 * already assumed re-login was the answer; we only switch when the
 * message clearly indicates a transient page failure.
 */
export function detectSessionErrorKind(message: string | undefined): SessionErrorKind {
  if (!message) return "auth-expired";
  const msg = String(message);
  for (const re of PAGE_NOT_READY_PATTERNS) if (re.test(msg)) return "page-not-ready";
  return "auth-expired";
}

export interface ClassifiedSessionError {
  provider: SessionProvider;
  kind: SessionErrorKind;
}

/**
 * One-shot helper: takes message + node.data and returns the provider to re-login (or null).
 */
export function classifySessionError(
  message: string | undefined,
  nodeData: NodeDataBase | undefined,
): ClassifiedSessionError | null {
  const fallback = nodeData ? providerOfNode(nodeData) : null;
  const provider = detectSessionErrorProvider(message, fallback);
  if (!provider) return null;
  return { provider, kind: detectSessionErrorKind(message) };
}
