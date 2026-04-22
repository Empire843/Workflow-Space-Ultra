/**
 * Shared cancellation primitives for the server-side job pipeline.
 *
 * The executor owns the job queue (`getJob(id).cancelRequested`) and the
 * VEO provider layer lives beneath it. Both need to agree on what a
 * "cancelled" throw looks like so that:
 *   - the executor can tag the job as `cancelled` instead of `error`
 *   - provider-side loops (the 403 recovery ladder, the batcher, the
 *     reCAPTCHA collector lock) can unwind as soon as the user asks to
 *     stop, without waiting for the next natural boundary.
 *
 * Keeping this file free of any queue / executor imports avoids a
 * circular dependency — providers only see the class and helpers.
 */

/**
 * Signature of the cancel check closure each caller hands down to the
 * provider. A sync function is intentional: we read a boolean flag on
 * the job record; there's no need for Promises or AbortController in the
 * hot path, and sync checks let us put `ensureNotCancelled(shouldCancel)`
 * at tight loop boundaries without turn-waiting.
 */
export type ShouldCancel = () => boolean;

/**
 * Thrown whenever a blocked operation notices `shouldCancel()` went true.
 * The executor catches `JobCancelledError` specifically and transitions
 * the job to `status=cancelled` rather than `error`; any other Error
 * type would show up as a generic failure.
 */
export class JobCancelledError extends Error {
  constructor(msg = "Cancelled") {
    super(msg);
    this.name = "JobCancelledError";
  }
}

/** `true` when `err` is a cancellation thrown from anywhere in the stack. */
export function isJobCancelled(err: unknown): boolean {
  return err instanceof JobCancelledError;
}

/**
 * Throw `JobCancelledError` if `shouldCancel` is defined and returns
 * true. Callers pass `undefined` when cancellation is not wired up (e.g.
 * unit tests, standalone scripts) — in that case this is a no-op.
 */
export function ensureNotCancelled(shouldCancel?: ShouldCancel): void {
  if (shouldCancel && shouldCancel()) {
    throw new JobCancelledError();
  }
}

/**
 * Sleep for `ms` milliseconds but wake up early (and throw) when the
 * user cancels. Used for the "wait 3-8s before retrying reCAPTCHA" and
 * the cooldown countdown so a cancelled job unwinds within ~200ms
 * instead of sitting through the full delay.
 *
 * Implementation: a fixed 200ms polling tick. Simpler than juggling an
 * AbortController and more than responsive enough for the cancel UX
 * (the button in the UI itself polls at a similar cadence).
 */
export async function cancelableSleep(
  ms: number,
  shouldCancel?: ShouldCancel,
  tickMs = 200,
): Promise<void> {
  if (ms <= 0) {
    ensureNotCancelled(shouldCancel);
    return;
  }
  const deadline = Date.now() + ms;
  while (true) {
    ensureNotCancelled(shouldCancel);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(tickMs, remaining)));
  }
}

/**
 * Race a promise against cancellation. If `shouldCancel()` flips while
 * `op` is pending, this resolves by throwing `JobCancelledError`; the
 * underlying operation keeps running (we can't force-abort a generic
 * Promise) but the caller is released immediately so higher layers can
 * move on.
 *
 * Use for long operations that DO have their own internal timeout (e.g.
 * `getFreshRecaptchaToken` with a 25s deadline, `page.request.post`
 * with 60s). The dangling work completes in the background and its
 * result is discarded.
 */
export async function raceCancel<T>(
  op: Promise<T>,
  shouldCancel?: ShouldCancel,
  pollMs = 200,
): Promise<T> {
  if (!shouldCancel) return op;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  try {
    const cancelWatcher = new Promise<never>((_resolve, reject) => {
      pollTimer = setInterval(() => {
        if (shouldCancel()) {
          reject(new JobCancelledError());
        }
      }, pollMs);
    });
    return await Promise.race([op, cancelWatcher]);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}
