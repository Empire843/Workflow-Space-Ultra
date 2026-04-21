/**
 * Shared error classifiers for the Grok provider layer.
 *
 * Mirrors `providers/veo/errors.ts` so both providers have the same shape
 * of helpers — detection + retry loop + page-closed recovery.
 */

/**
 * 401/403-style failures we treat as "statsig token / cookie expired".
 *
 * Grok returns 401 from its REST endpoints when the statsig header is
 * stale and 403 when the session cookie rotated under us. Both signal
 * the same thing: refresh via `autoDiscoverStatsig({ force: true })` and
 * retry the HTTP call — not a full collector reset.
 */
export function isGrokUnauthenticated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b401\b/.test(msg) ||
    /\b403\b/.test(msg) ||
    /unauthorized/i.test(msg) ||
    /forbidden/i.test(msg) ||
    /UNAUTHENTICATED/i.test(msg) ||
    /session\s*(?:expired|invalid)/i.test(msg) ||
    /token\s*(?:expired|invalid)/i.test(msg) ||
    /statsig.*(?:expired|invalid)/i.test(msg) ||
    /need\s*(?:re-?login|to\s*login)/i.test(msg)
  );
}

/**
 * Playwright's "target closed" family — tab/renderer died mid-call. The
 * Chrome window + login are still fine, so the right recovery is to
 * `getLivePage()` and retry, NOT to blow up the singleton collector.
 */
export function isGrokPageClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Target page, context or browser has been closed/i.test(msg) ||
    /Target closed/i.test(msg) ||
    /page\.evaluate:\s*(?:Target|Protocol|Connection)/i.test(msg) ||
    /page has been closed/i.test(msg) ||
    /Request context disposed/i.test(msg) ||
    /Protocol error.*Target closed/i.test(msg)
  );
}

/**
 * Should `resetGrokCollector` actually nuke the singleton? Only when CDP
 * is demonstrably dead — "timeout", "session expired" and similar network
 * glitches are handled by the 401 retry loop in `withGrokAuthRetry`,
 * **not** by tearing down Chrome.
 */
export function isGrokCdpDeadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Target closed/i.test(msg) ||
    /browserContext.*closed/i.test(msg) ||
    /browser has been closed/i.test(msg) ||
    /WebSocket.*close/i.test(msg) ||
    /ECONNREFUSED/i.test(msg) ||
    /disconnected/i.test(msg)
  );
}
