import { randomUUID } from "node:crypto";

import { loadConfig, type AccountType } from "../../config";
import { timedSpan } from "../../telemetry/timing";
import { getVeoCollector } from "../../tokens/veoTokenCollector";
import {
  cancelableSleep,
  ensureNotCancelled,
  JobCancelledError,
  raceCancel,
  type ShouldCancel,
} from "../cancellation";

import {
  buildCreateImagePayload,
  parseGeneratedImages,
  requestCreateImageViaBrowser,
  type CreateImageOptions,
  type GeneratedImage,
} from "./createImage";
import { bumpAndMaybeClear, preCaptureJitter } from "./captureCounter";
import { URL_GENERATE_IMAGES_TEMPLATE } from "./constants";
import {
  cooldownRemainingMs,
  recordRecaptchaStrike,
  waitForCooldown,
} from "./cooldown";
import {
  isRecaptchaCaptureTimeout,
  isRecaptchaError,
  isTransientPageError,
  isUnauthenticated,
} from "./errors";
import { postJsonViaBrowser } from "./http";

/**
 * R2 — Request coalescing for VEO `batchGenerateImages`.
 *
 * The API accepts `requests: [r1, r2, ...]` in a single call, each with its
 * own prompt / seed / aspectRatio / referenceImages. When multiple workflow
 * nodes generate images in quick succession, we can merge their individual
 * calls into one HTTP POST + one reCAPTCHA token — saving N-1 × (reCAPTCHA +
 * API roundtrip).
 *
 * Design:
 *   - `submit(opts)` enqueues a request and returns a Promise resolving to
 *     that caller's slice of generated images.
 *   - A 300ms tick (configurable) collects additional submits, then flushes.
 *   - If `batch.size === MAX_BATCH`, flush immediately.
 *   - Requests are grouped by `modelLabel` (different image models cannot be
 *     merged into one API call — response demux would be ambiguous).
 *   - Demux by "sample-count boundaries": caller i asked for `outputCount[i]`
 *     images, so it gets images[sum[0..i-1] : sum[0..i]].
 *   - If the response count doesn't match the sum of expected counts (API
 *     partial failure, image filter, etc.), the whole batch falls back to
 *     N individual calls — zero data loss, just no speedup.
 *
 * Safety:
 *   - Opt-in via `VEO_IMAGE_BATCH=1`. When OFF the executor calls the direct
 *     path as before.
 *   - Each caller's `seed`, `aspectRatio`, `referenceImages` travel with its
 *     own request item — no cross-contamination.
 *   - reCAPTCHA is captured once for the whole batch; `buildAuth` is also
 *     shared. reCAPTCHA token is put into top-level `clientContext` *and*
 *     each per-request `clientContext` (matching the captured UI payload).
 */

export interface BatchSubmitResult {
  raw: GeneratedImage[];
}

export interface BatcherConfig {
  /** Max requests merged into one API call. */
  maxBatchSize: number;
  /** Wait window in milliseconds before flushing an incomplete batch. */
  windowMs: number;
}

export function readBatcherConfig(): { enabled: boolean } & BatcherConfig {
  // Batching is ON by default now. With browser-routed requests, one
  // reCAPTCHA safely covers 3 prompts, so enabling the batcher means
  // fewer token mints per workflow → much less chance of hitting the
  // per-account rate limit. Users can still disable with VEO_IMAGE_BATCH=0.
  const enabled = process.env.VEO_IMAGE_BATCH !== "0";
  const maxBatchSize = Math.max(
    1,
    // Default dropped 4 → 3: small batches keep one bad token from
    // wrecking 4 callers, and the Python reference uses 3.
    Math.min(8, Number(process.env.VEO_IMAGE_BATCH_MAX || "3"))
  );
  const windowMs = Math.max(
    0,
    // Bumped 300 → 400ms: a slightly wider window lets more legitimate
    // concurrent callers join the same batch instead of firing solo.
    Math.min(2000, Number(process.env.VEO_IMAGE_BATCH_WINDOW_MS || "400"))
  );
  return { enabled, maxBatchSize, windowMs };
}

type LogFn = (msg: string) => void;

interface PendingEntry {
  opts: Omit<
    CreateImageOptions,
    "recaptchaToken" | "accessToken" | "sessionId" | "projectId" | "cookie" | "accountType"
  >;
  log?: LogFn;
  /**
   * Per-caller cancel probe. Captured at submit time so each entry can
   * be evicted independently — one cancelled job in a batch of 3 must
   * not drag the other two down.
   */
  shouldCancel?: ShouldCancel;
  resolve: (r: BatchSubmitResult) => void;
  reject: (e: unknown) => void;
}

/**
 * Drop any entries whose caller has cancelled. Used before every slice of
 * work (window flush, group dispatch, per-item retry) so a cancelled job
 * never spends a reCAPTCHA token or blocks healthy siblings. Rejected
 * entries receive a `JobCancelledError` which the executor maps to
 * `status=cancelled`.
 */
function dropCancelled(entries: PendingEntry[]): PendingEntry[] {
  const alive: PendingEntry[] = [];
  for (const e of entries) {
    if (e.shouldCancel?.()) {
      e.reject(new JobCancelledError());
    } else {
      alive.push(e);
    }
  }
  return alive;
}

class CreateImageBatcher {
  private pending: PendingEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private cfg: BatcherConfig) {}

  submit(
    opts: PendingEntry["opts"],
    log?: LogFn,
    shouldCancel?: ShouldCancel,
  ): Promise<BatchSubmitResult> {
    return new Promise<BatchSubmitResult>((resolve, reject) => {
      // Reject immediately if the caller is already cancelled by the time
      // they call `submit`. Avoids enqueueing zombies that wake up only
      // to be dropped.
      if (shouldCancel?.()) {
        reject(new JobCancelledError());
        return;
      }
      this.pending.push({ opts, log, shouldCancel, resolve, reject });
      if (this.pending.length >= this.cfg.maxBatchSize) {
        void this.flushSoon(0);
      } else if (!this.timer) {
        this.timer = setTimeout(() => void this.flushSoon(0), this.cfg.windowMs);
      }
    });
  }

  private async flushSoon(_delay: number): Promise<void> {
    if (this.flushing) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        let take = this.pending.splice(0, this.cfg.maxBatchSize);
        // Evict anyone cancelled between submit and flush so we don't
        // waste a reCAPTCHA token on them.
        take = dropCancelled(take);
        if (!take.length) continue;
        // Group by modelLabel — different models can't be merged.
        const groups = new Map<string, PendingEntry[]>();
        for (const entry of take) {
          const key = entry.opts.modelLabel || "Nano Banana 2";
          const arr = groups.get(key);
          if (arr) arr.push(entry);
          else groups.set(key, [entry]);
        }
        for (const group of groups.values()) {
          await this.dispatchGroup(group);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async dispatchGroup(group: PendingEntry[]): Promise<void> {
    group = dropCancelled(group);
    if (!group.length) return;
    if (group.length === 1) {
      await this.dispatchSingle(group[0]);
      return;
    }
    const log = (msg: string) => group.forEach((g) => g.log?.(msg));
    // Any member's cancel flag fires the group-level probe. Individual
    // entries are re-checked and evicted per checkpoint so the group
    // keeps running for everyone still alive.
    const groupShouldCancel: ShouldCancel = () => group.every((g) => Boolean(g.shouldCancel?.()));
    log(`[batch] merging ${group.length} gen.image requests…`);

    // Block the whole batch if Google is cooling us down. One batch using a
    // bad token would strike every entry inside it at once.
    if (cooldownRemainingMs() > 0) await waitForCooldown(log, groupShouldCancel);

    try {
      if (groupShouldCancel()) throw new JobCancelledError();
      await timedSpan("veo.batch.createImage", async () => {
        // Race every Playwright/network await against the group cancel
        // so a stuck Chrome boot can't pin all callers. Once we're past
        // these points, each `await raceCancel(...)` later in the path
        // provides another escape hatch.
        const collector = await raceCancel(getVeoCollector(), groupShouldCancel);
        const auth = await raceCancel(collector.collectAuth(), groupShouldCancel);
        const config = loadConfig();
        const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";

        // VEO Strike Prevention: proactive periodic storage clear +
        // human-pause jitter BEFORE we mint a token. One bump per
        // merged batch (not per entry) — the batch really does send
        // one recaptcha token for N prompts, so counting each entry
        // would over-clear and reset the counter prematurely.
        await bumpAndMaybeClear(collector, "image", log, groupShouldCancel);
        await preCaptureJitter(groupShouldCancel);

        // Fetch recaptcha and grab the image-mode page in the same step:
        // the follow-up POST has to go through THIS tab or the fingerprint
        // no longer matches the minted token.
        const recaptcha = await raceCancel(
          timedSpan("veo.recaptcha.image", () =>
            collector.getFreshRecaptchaToken(
              { timeoutMs: 25_000, mode: "image", shouldCancel: groupShouldCancel },
              "image",
              groupShouldCancel,
            ),
          ),
          groupShouldCancel,
        );
        const imagePage = await raceCancel(collector.getPageForMode("image"), groupShouldCancel);

        // Build merged payload: reuse buildCreateImagePayload per-caller to
        // produce the nested `requests` array, then concatenate.
        const boundaries: Array<{ entry: PendingEntry; take: number }> = [];
        const mergedRequests: unknown[] = [];
        for (const entry of group) {
          const payload = buildCreateImagePayload({
            ...entry.opts,
            recaptchaToken: recaptcha,
            accessToken: auth.accessToken,
            sessionId: auth.sessionId,
            projectId: auth.projectId,
            cookie: auth.cookie,
            accountType,
          });
          const reqs = (payload.requests ?? []) as unknown[];
          boundaries.push({ entry, take: reqs.length });
          mergedRequests.push(...reqs);
        }

        const firstClientContext = {
          recaptchaContext: {
            token: recaptcha,
            applicationType: "RECAPTCHA_APPLICATION_TYPE_WEB",
          },
          sessionId: auth.sessionId,
          projectId: auth.projectId,
          tool: "PINHOLE",
        };
        const mergedPayload = {
          clientContext: firstClientContext,
          mediaGenerationContext: { batchId: randomUUID() },
          useNewMedia: true,
          requests: mergedRequests,
        };

        const url = URL_GENERATE_IMAGES_TEMPLATE.replace("{projectId}", auth.projectId);
        const res = await raceCancel(
          timedSpan("veo.api.createImage", () =>
            postJsonViaBrowser(imagePage, url, mergedPayload, auth.accessToken),
          ),
          groupShouldCancel,
        );
        if (!res.ok) {
          const detail = res.body?.slice(0, 400) || res.error || "(no response body)";
          throw new Error(`VEO batchCreateImage ${res.status}: ${detail}`);
        }

        const allImages = parseGeneratedImages(res.body);
        const expectedTotal = boundaries.reduce((sum, b) => sum + b.take, 0);
        if (allImages.length !== expectedTotal) {
          throw new Error(
            `demux mismatch: got ${allImages.length} images for ${expectedTotal} slots — falling back to individual calls`
          );
        }

        // Demux in request order.
        let cursor = 0;
        for (const b of boundaries) {
          const slice = allImages.slice(cursor, cursor + b.take);
          cursor += b.take;
          b.entry.resolve({ raw: slice });
        }
      });
    } catch (err) {
      // Cancellation of the entire group = every caller already opted
      // out. Fail each entry with JobCancelledError and skip the
      // expensive per-item fallback.
      if (err instanceof JobCancelledError) {
        for (const entry of group) entry.reject(new JobCancelledError());
        return;
      }

      // 401 almost always means the shared access token expired between
      // when we cached it and now. Refresh once at the group level so
      // every fallback `dispatchSingle` sees the new token — otherwise
      // all N fallbacks would read the same stale cached auth and each
      // re-hit 401 before finally bubbling a bogus "please re-login"
      // error to the UI. (Mirrors `withRecaptcha`'s 401 branch.)
      if (isUnauthenticated(err)) {
        log("[batch] access token expired (401) — đang refresh session…");
        try {
          const collector = await getVeoCollector();
          collector.invalidateAuth();
          collector.invalidateRecaptchaCache();
          await collector.collectAuth({ force: true });
        } catch (refreshErr) {
          // If refresh itself fails, fall through to per-item retry —
          // each dispatchSingle will try again and report its own error.
          const rmsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
          log(`[batch] auth refresh failed: ${rmsg} — sẽ thử từng request.`);
        }
      }

      // Transient tab/network failure on the batch POST. The cached
      // image page handle is likely stale — dump it so every
      // dispatchSingle fallback below re-attaches to a fresh tab
      // instead of inheriting the same dead handle.
      if (isTransientPageError(err)) {
        log("[batch] tab image có vẻ đã ngắt — sẽ mở lại trước khi thử từng request.");
        try {
          const collector = await getVeoCollector();
          collector.invalidatePageForMode("image");
          collector.invalidateRecaptchaCache();
        } catch {
          // best-effort — dispatchSingle's own transient branch covers us
        }
      }

      // Capture-side recaptcha timeout on the batch: the image tab
      // failed to return a token in time. Drop the page + recaptcha
      // caches so each `dispatchSingle` fallback below starts by
      // re-navigating to a project page (instead of inheriting the
      // same half-frozen tab). Without this the per-item fallback
      // also pays the full 40s first-use timeout and all N entries
      // end up rejected with the same message.
      if (isRecaptchaCaptureTimeout(err)) {
        log("[batch] recaptcha capture timeout — mở lại tab image trước khi thử từng request.");
        try {
          const collector = await getVeoCollector();
          collector.invalidatePageForMode("image");
          collector.invalidateRecaptchaCache();
        } catch {
          // best-effort
        }
      }

      // A genuine 403 UNUSUAL_ACTIVITY from the batch POST. Google is
      // mad at the whole account, not just this request. Record a
      // strike so every other in-flight caller (including the per-item
      // fallbacks we're about to kick off) sees `cooldownRemainingMs()`
      // > 0 at the top of their loops and waits it out. The debounce
      // inside `recordRecaptchaStrike` stops 4 concurrent groups hitting
      // this line at the same millisecond from catapulting us to the
      // 240s tier in one burst.
      if (isRecaptchaError(err)) {
        const cd = recordRecaptchaStrike();
        log(
          `[batch] Google flag 403 UNUSUAL_ACTIVITY — lane VEO cooldown ` +
            `${(cd.delayMs / 1000).toFixed(0)}s (strike #${cd.strikes}).`,
        );
      }

      const msg = err instanceof Error ? err.message : String(err);
      log(`[batch] failed (${msg}); falling back to individual calls.`);

      // Per-item fallback below uses the same 403 ladder as
      // `withRecaptcha` (clearStorage, then restartBrowser). Genuine
      // abuse flags get their cooldown from the strike recorded above;
      // everything else (401, transient tab) falls through the other
      // branches above.
      for (const entry of group) {
        if (entry.shouldCancel?.()) {
          entry.reject(new JobCancelledError());
          continue;
        }
        try {
          await this.dispatchSingle(entry);
        } catch (e) {
          entry.reject(e);
        }
      }
    }
  }

  private async dispatchSingle(entry: PendingEntry): Promise<void> {
    // Single-item path through the same browser-routed ladder as
    // `withRecaptcha`: retry → clearStorage → restartBrowser. Stays
    // parallel to `veoCreateImage` so a solo submit behaves identically
    // to the non-batched code, and the batcher's fallback on a failed
    // merge can lean on the full recovery machinery.
    const maxAttempts = 4;
    const log = entry.log;
    const shouldCancel = entry.shouldCancel;
    let attempt = 0;
    try {
      while (true) {
        attempt++;
        ensureNotCancelled(shouldCancel);
        if (cooldownRemainingMs() > 0) await waitForCooldown(log, shouldCancel);
        if (attempt > 1) {
          const d = 3000 + Math.floor(Math.random() * 5000);
          log?.(`Đợi ${(d / 1000).toFixed(1)}s trước khi thử lại…`);
          await cancelableSleep(d, shouldCancel);
        }
        try {
          const collector = await raceCancel(getVeoCollector(), shouldCancel);
          const auth = await raceCancel(collector.collectAuth(), shouldCancel);
          const config = loadConfig();
          const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";
          // VEO Strike Prevention: same periodic clear + jitter as the
          // merged batch path. Only on the first attempt — the retry
          // escalation ladder below has its own recovery steps.
          if (attempt === 1) {
            await bumpAndMaybeClear(collector, "image", log, shouldCancel);
            await preCaptureJitter(shouldCancel);
          }
          const recaptcha = await raceCancel(
            timedSpan("veo.recaptcha.image", () =>
              collector.getFreshRecaptchaToken(
                { timeoutMs: 25_000, mode: "image", shouldCancel },
                "image",
                shouldCancel,
              ),
            ),
            shouldCancel,
          );
          const imagePage = await raceCancel(collector.getPageForMode("image"), shouldCancel);
          const res = await raceCancel(
            timedSpan("veo.api.createImage", () =>
              requestCreateImageViaBrowser(imagePage, {
                ...entry.opts,
                recaptchaToken: recaptcha,
                accessToken: auth.accessToken,
                sessionId: auth.sessionId,
                projectId: auth.projectId,
                cookie: auth.cookie,
                accountType,
              }),
            ),
            shouldCancel,
          );
          if (!res.ok) {
            const detail = res.body?.slice(0, 400) || res.error || "(no response body)";
            throw new Error(`VEO createImage ${res.status}: ${detail}`);
          }
          entry.resolve({ raw: parseGeneratedImages(res.body) });
          return;
        } catch (err) {
          // Cancellation always exits the loop — never retry a cancelled op.
          if (err instanceof JobCancelledError) throw err;
          // Transient tab/network failure (status=0, Target closed, etc.).
          // The access token and recaptcha are still valid — we only need
          // a fresh page handle. Do NOT burn a 403-escalation slot on these
          // or Google will never see a real retry.
          if (attempt < maxAttempts && isTransientPageError(err)) {
            ensureNotCancelled(shouldCancel);
            const snippet = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
            log?.(`Tab VEO bị ngắt giữa chừng — đang mở lại tab image… (${snippet})`);
            const collector = await getVeoCollector();
            collector.invalidatePageForMode("image");
            collector.invalidateRecaptchaCache();
            continue;
          }
          // 401 branch: token expired. Refresh auth + recaptcha cache
          // and retry immediately (no exponential delay — this is not a
          // Google penalty, just a stale OAuth credential). Mirrors the
          // 401 branch of `withRecaptcha` in index.ts.
          if (attempt < maxAttempts && isUnauthenticated(err)) {
            ensureNotCancelled(shouldCancel);
            log?.("Token hết hạn (401) — đang refresh session…");
            const collector = await getVeoCollector();
            collector.invalidateAuth();
            collector.invalidateRecaptchaCache();
            try {
              await collector.collectAuth({ force: true });
            } catch (refreshErr) {
              // Let the next loop iteration surface the refresh error
              // naturally; don't swallow it here.
              throw refreshErr;
            }
            continue;
          }
          // Capture-side recaptcha timeout: the Flow tab never fired
          // `/recaptcha/enterprise/reload` within our deadline. Usually
          // the cached page is on the wrong project page / got
          // background-throttled / a modal intercepted the click. Drop
          // the page handle + recaptcha cache so the next attempt
          // re-navigates and re-captures. Mirrors the capture-timeout
          // branch of `withRecaptcha` in index.ts. Without this branch
          // the first capture timeout would bubble straight to the user
          // even though the recovery is trivial.
          if (attempt < maxAttempts && isRecaptchaCaptureTimeout(err)) {
            ensureNotCancelled(shouldCancel);
            log?.(
              `Page Flow chưa trả recaptcha (mode=image) — mở lại tab và thử lần ${attempt + 1}/${maxAttempts}…`,
            );
            const collector = await getVeoCollector();
            collector.invalidatePageForMode("image");
            collector.invalidateRecaptchaCache();
            continue;
          }
          if (attempt < maxAttempts && isRecaptchaError(err)) {
            ensureNotCancelled(shouldCancel);
            const collector = await raceCancel(getVeoCollector(), shouldCancel);
            collector.invalidateRecaptchaCache();
            // Record a strike + trigger lane-wide cooldown. Debounced
            // across concurrent 403s from the same burst — see
            // cooldown.ts. The next loop iteration will call
            // `waitForCooldown` at the top and block here until Google
            // is ready for us again.
            const cd = recordRecaptchaStrike();
            log?.(
              `Lane VEO cooldown ${(cd.delayMs / 1000).toFixed(0)}s ` +
                `(strike #${cd.strikes}) — đợi trước khi thử lại…`,
            );
            const nextAttempt = attempt + 1;
            if (nextAttempt === 3) {
              log?.("Google flag 403 lần 2 — xóa site storage + reload tab image…");
              await raceCancel(collector.clearSiteStorage("image"), shouldCancel);
            } else if (nextAttempt === 4) {
              log?.("Google flag 403 lần 3 — khởi động lại Chrome…");
              await raceCancel(collector.restartBrowser(), shouldCancel);
            } else {
              log?.("Google flag 403 — thử lại với token mới…");
            }
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      entry.reject(err);
    }
  }
}

// Lazy singleton so the batcher is initialized once per Node process.
let _batcher: CreateImageBatcher | null = null;
let _batcherCfgKey: string | null = null;

export function getCreateImageBatcher(): CreateImageBatcher {
  const cfg = readBatcherConfig();
  const key = `${cfg.maxBatchSize}:${cfg.windowMs}`;
  if (!_batcher || _batcherCfgKey !== key) {
    _batcher = new CreateImageBatcher({
      maxBatchSize: cfg.maxBatchSize,
      windowMs: cfg.windowMs,
    });
    _batcherCfgKey = key;
  }
  return _batcher;
}

/** Reset — tests only. */
export function resetCreateImageBatcherForTests(): void {
  _batcher = null;
  _batcherCfgKey = null;
}
