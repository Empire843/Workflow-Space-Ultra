import { randomUUID } from "node:crypto";

import { loadConfig, type AccountType } from "../../config";
import { timedSpan } from "../../telemetry/timing";
import { getVeoCollector } from "../../tokens/veoTokenCollector";

import {
  buildCreateImagePayload,
  parseGeneratedImages,
  requestCreateImage,
  type CreateImageOptions,
  type GeneratedImage,
} from "./createImage";
import { URL_GENERATE_IMAGES_TEMPLATE } from "./constants";
import {
  cooldownRemainingMs,
  recordRecaptchaStrike,
  waitForCooldown,
} from "./cooldown";
import { postJsonWithToken } from "./http";

function isRecaptchaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(msg) ||
    /reCAPTCHA evaluation failed/i.test(msg) ||
    /PERMISSION_DENIED/i.test(msg)
  );
}

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
  const enabled = process.env.VEO_IMAGE_BATCH === "1";
  const maxBatchSize = Math.max(
    1,
    Math.min(8, Number(process.env.VEO_IMAGE_BATCH_MAX || "4"))
  );
  const windowMs = Math.max(
    0,
    Math.min(2000, Number(process.env.VEO_IMAGE_BATCH_WINDOW_MS || "300"))
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
  resolve: (r: BatchSubmitResult) => void;
  reject: (e: unknown) => void;
}

class CreateImageBatcher {
  private pending: PendingEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(private cfg: BatcherConfig) {}

  submit(
    opts: PendingEntry["opts"],
    log?: LogFn
  ): Promise<BatchSubmitResult> {
    return new Promise<BatchSubmitResult>((resolve, reject) => {
      this.pending.push({ opts, log, resolve, reject });
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
        const take = this.pending.splice(0, this.cfg.maxBatchSize);
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
    if (!group.length) return;
    if (group.length === 1) {
      await this.dispatchSingle(group[0]);
      return;
    }
    const log = (msg: string) => group.forEach((g) => g.log?.(msg));
    log(`[batch] merging ${group.length} gen.image requests…`);

    // Block the whole batch if Google is cooling us down. One batch using a
    // bad token would strike every entry inside it at once.
    if (cooldownRemainingMs() > 0) await waitForCooldown(log);

    try {
      await timedSpan("veo.batch.createImage", async () => {
        // Shared auth + reCAPTCHA for the whole merged payload.
        const collector = await getVeoCollector();
        const auth = await collector.collectAuth();
        const config = loadConfig();
        const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";

        const recaptcha = await timedSpan("veo.recaptcha.image", () =>
          collector.getFreshRecaptchaToken(25_000, "image")
        );

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
        const res = await timedSpan("veo.api.createImage", () =>
          postJsonWithToken(url, mergedPayload, auth.accessToken, auth.cookie)
        );
        if (!res.ok) {
          throw new Error(
            `VEO batchCreateImage ${res.status}: ${res.body.slice(0, 400)}`
          );
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
      const msg = err instanceof Error ? err.message : String(err);
      log(`[batch] failed (${msg}); falling back to individual calls.`);

      // Batch hit UNUSUAL_ACTIVITY: the whole account is now in cooldown.
      // Record a strike so every other VEO job respects the same window,
      // and skip the per-item fallback — firing N more reCAPTCHA calls
      // inside the punishment window would just reset the timer.
      if (isRecaptchaError(err)) {
        const { delayMs, strikes } = recordRecaptchaStrike();
        log(
          `Google flag UNUSUAL_ACTIVITY (batch, strike #${strikes}). Đợi cooldown ${Math.round(delayMs / 1000)}s rồi chạy lại từng item…`,
        );
        await waitForCooldown(log);
      }

      // Fallback: fire each request as its own non-batched call.
      // We run them sequentially (lane serialization still applies) to avoid
      // hammering the API after a partial failure.
      for (const entry of group) {
        try {
          await this.dispatchSingle(entry);
        } catch (e) {
          entry.reject(e);
        }
      }
    }
  }

  private async dispatchSingle(entry: PendingEntry): Promise<void> {
    // Mirrors the direct veoCreateImage path so a single-item batch behaves
    // identically to the non-batched code. Retries on UNUSUAL_ACTIVITY with
    // full lane-wide cooldown so we don't keep burning tokens inside the
    // Google punishment window.
    const maxAttempts = 4;
    const log = entry.log;
    let attempt = 0;
    try {
      while (true) {
        attempt++;
        if (cooldownRemainingMs() > 0) await waitForCooldown(log);
        try {
          const collector = await getVeoCollector();
          const auth = await collector.collectAuth();
          const config = loadConfig();
          const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";
          const recaptcha = await timedSpan("veo.recaptcha.image", () =>
            collector.getFreshRecaptchaToken(25_000, "image")
          );
          const res = await timedSpan("veo.api.createImage", () =>
            requestCreateImage({
              ...entry.opts,
              recaptchaToken: recaptcha,
              accessToken: auth.accessToken,
              sessionId: auth.sessionId,
              projectId: auth.projectId,
              cookie: auth.cookie,
              accountType,
            })
          );
          if (!res.ok) {
            throw new Error(`VEO createImage ${res.status}: ${res.body.slice(0, 400)}`);
          }
          entry.resolve({ raw: parseGeneratedImages(res.body) });
          return;
        } catch (err) {
          if (attempt < maxAttempts && isRecaptchaError(err)) {
            const { delayMs, strikes } = recordRecaptchaStrike();
            log?.(
              `Google flag UNUSUAL_ACTIVITY (strike #${strikes}). Đợi cooldown ${Math.round(delayMs / 1000)}s rồi thử lại…`,
            );
            await waitForCooldown(log);
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
