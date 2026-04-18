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
 * One-shot helper: takes message + node.data and returns the provider to re-login (or null).
 */
export function classifySessionError(
  message: string | undefined,
  nodeData: NodeDataBase | undefined,
): SessionProvider | null {
  const fallback = nodeData ? providerOfNode(nodeData) : null;
  return detectSessionErrorProvider(message, fallback);
}
