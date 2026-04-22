/**
 * Shared error classifiers for the VEO provider layer.
 *
 * Split out of `index.ts` so `batcher.ts` can consume them without
 * creating a circular import (`index.ts` imports `batcher.ts` for the
 * `getCreateImageBatcher` singleton).
 */

export function isRecaptchaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(msg) ||
    /reCAPTCHA evaluation failed/i.test(msg) ||
    /PERMISSION_DENIED/i.test(msg) ||
    / 403/.test(msg)
  );
}

export function isUnauthenticated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return / 401/.test(msg) || /UNAUTHENTICATED/i.test(msg);
}

/**
 * Transient page/network errors that happen when `postJsonViaBrowser`
 * (or any `page.context().request.post`) blows up before a real HTTP
 * response is received. Symptoms we see in the wild:
 *   - "VEO createImage 0:" / "VEO t2v create 0:"  (status=0, body empty)
 *   - "Target page, context or browser has been closed"
 *   - "Target closed" / "page has been closed"
 *   - "socket hang up" / "ECONNRESET" / "Request context disposed"
 *   - "Timeout 60000ms exceeded"
 *
 * These are NOT Google penalties — usually a tab was recycled, the CDP
 * channel glitched, or a request timed out mid-stream. The right
 * recovery is: drop the cached page handle so the next `getPageForMode`
 * re-attaches to a live tab, then retry. Do NOT force a recaptcha
 * refresh (token is still valid) and do NOT escalate to
 * clearStorage / restartBrowser.
 */
export function isTransientPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    / 0:/.test(msg) ||
    /Target (?:page, context or browser )?(?:has been )?closed/i.test(msg) ||
    /page has been closed/i.test(msg) ||
    /Request context disposed/i.test(msg) ||
    /Protocol error.*Target closed/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /ECONNRESET/i.test(msg) ||
    /EPIPE/i.test(msg) ||
    /Timeout\s*\d+ms exceeded/i.test(msg) ||
    /apiRequestContext\.post/i.test(msg)
  );
}
