import type { Page } from "playwright";

import { loadConfig, type AccountType } from "../../config";
import { timedSpan } from "../../telemetry/timing";
import { getVeoCollector, type VeoTokenCollector } from "../../tokens/veoTokenCollector";
import {
  cancelableSleep,
  ensureNotCancelled,
  raceCancel,
  type ShouldCancel,
} from "../cancellation";

import { getCreateImageBatcher, readBatcherConfig } from "./batcher";
import { cooldownRemainingMs, waitForCooldown } from "./cooldown";
import {
  isRecaptchaError,
  isTransientPageError,
  isUnauthenticated,
} from "./errors";
import {
  buildCreateImagePayload,
  parseGeneratedImages,
  requestCreateImageViaBrowser,
  type CreateImageOptions,
  type GeneratedImage,
} from "./createImage";
import { downloadToDisk } from "./download";
import {
  buildI2VPayload,
  parseUploadMediaId,
  requestCreateI2VViaBrowser,
  requestUploadUserImageViaBrowser,
  type I2VCreateOptions,
  type UploadImageOptions,
} from "./imageToVideo";
import {
  parseOperationsFromCreateResponse,
  requestCheckStatus,
  requestCreateT2VViaBrowser,
  type OperationRef,
  type StatusEntry,
  type T2VCreateOptions,
} from "./textToVideo";

export * from "./constants";
export * from "./createImage";
export * from "./imageToVideo";
export * from "./textToVideo";
export { downloadToDisk } from "./download";

/**
 * High-level VEO provider: handles ensureAuth + recaptcha + a single retry on 401.
 */

type LogFn = (msg: string) => void;

interface AuthCtx {
  accessToken: string;
  sessionId: string;
  projectId: string;
  cookie: string;
  accountType: AccountType;
}

async function buildBaseAuth(onLog?: LogFn) {
  return timedSpan("veo.buildAuth", async () => {
    onLog?.("Kết nối VEO session…");
    const collector = await getVeoCollector();
    const auth = await collector.collectAuth();
    const config = loadConfig();
    const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";
    onLog?.("Session OK. Chuẩn bị reCAPTCHA…");
    return { collector, auth, accountType };
  });
}

/**
 * Run `fn` with a fresh recaptcha token **and** the browser tab that
 * minted it. `fn` should call one of the `*ViaBrowser` wrappers with the
 * given page so the resulting HTTP request shares the reCAPTCHA token's
 * fingerprint (UA, TLS, Sec-CH-UA, Origin, Referer, cookies).
 *
 * ## Error ladder
 *
 * ```
 * Attempt 1  →  ok        : return
 *            →  401       : invalidate auth, rebuild, retry (no escalation)
 *            →  403/Recap : escalate to Attempt 2 with random 3-8s delay
 * Attempt 2  →  ok        : return
 *            →  403/Recap : clearSiteStorage(mode) → Attempt 3
 * Attempt 3  →  ok        : return
 *            →  403/Recap : restartBrowser() → Attempt 4
 * Attempt 4  →  ok        : return
 *            →  403/Recap : throw (give up; safety-net cooldown kicks in)
 * ```
 *
 * This is the "Option 2" ladder from the Python reference
 * (`A_workflow_text_to_video.py` lines 481-542). We deliberately do NOT
 * call `recordRecaptchaStrike` on the happy path any more: once requests
 * go through the browser, legitimate 403s are rare enough that the
 * lane-wide cooldown only helps in genuine abuse situations, where the
 * clearStorage / restartBrowser steps are the real cure. `cooldown.ts`
 * is kept as a best-effort safety net (`cooldownRemainingMs()` is still
 * honoured at entry).
 */

const MAX_RECAPTCHA_ATTEMPTS = 4;

interface RecaptchaCtx {
  recaptcha: string;
  auth: AuthCtx;
  page: Page;
  collector: VeoTokenCollector;
}

async function withRecaptcha<T>(
  fn: (ctx: RecaptchaCtx) => Promise<T>,
  mode: "video" | "image" = "video",
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<T> {
  ensureNotCancelled(shouldCancel);
  let { collector, auth, accountType } = await buildBaseAuth(onLog);
  let attempt = 0;
  while (true) {
    attempt++;
    ensureNotCancelled(shouldCancel);

    // Safety-net cooldown only. Happy path never writes to it; if it's set,
    // some other lane hit a genuine abuse flag recently and we wait it out
    // before spending another recaptcha token.
    if (cooldownRemainingMs() > 0) {
      await waitForCooldown(onLog, shouldCancel);
    }

    // Human-like delay between retries (not the first attempt). Google
    // reCAPTCHA v3 Enterprise scores timing patterns: mechanical bursts
    // get lower scores and trigger UNUSUAL_ACTIVITY more often.
    if (attempt > 1) {
      const delayMs = 3000 + Math.floor(Math.random() * 5000);
      onLog?.(`Đợi ${(delayMs / 1000).toFixed(1)}s trước khi thử lại…`);
      await cancelableSleep(delayMs, shouldCancel);
    }

    onLog?.(attempt > 1 ? `Lấy reCAPTCHA token (retry ${attempt}/${MAX_RECAPTCHA_ATTEMPTS})… (~15-25s)` : "Lấy reCAPTCHA token… (~15-25s)");
    // Race the recaptcha capture against cancellation. The capture
    // itself can't be aborted mid-flight (Playwright is holding a page
    // lock), but raceCancel lets the caller unwind in ~200ms on cancel;
    // the dangling capture completes in the background and its token
    // is simply unused.
    const recaptcha = await raceCancel(
      timedSpan(`veo.recaptcha.${mode}`, () =>
        collector.getFreshRecaptchaToken(25_000, mode),
      ),
      shouldCancel,
    );
    ensureNotCancelled(shouldCancel);
    onLog?.("reCAPTCHA OK. Đang gửi request qua Chrome…");
    const page = await collector.getPageForMode(mode);
    const ctx: AuthCtx = {
      accessToken: auth.accessToken,
      sessionId: auth.sessionId,
      projectId: auth.projectId,
      cookie: auth.cookie,
      accountType,
    };
    try {
      return await raceCancel(fn({ recaptcha, auth: ctx, page, collector }), shouldCancel);
    } catch (err) {
      // Cancellation always exits the loop — never retry a cancelled op.
      if (err instanceof Error && err.name === "JobCancelledError") throw err;
      // Transient tab/network failure (e.g. status=0, Target closed). The
      // recaptcha token and auth are still valid — all we need is a fresh
      // page handle. Do NOT consume a 403-escalation slot on these.
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isTransientPageError(err)) {
        ensureNotCancelled(shouldCancel);
        const snippet = err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160);
        onLog?.(`Tab VEO bị ngắt giữa chừng — đang mở lại tab ${mode}… (${snippet})`);
        collector.invalidatePageForMode(mode);
        collector.invalidateRecaptchaCache();
        // Don't burn a full 3-8s retry delay here (it's gated on attempt>1
        // in the next loop iteration, which is fine).
        continue;
      }
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isUnauthenticated(err)) {
        ensureNotCancelled(shouldCancel);
        onLog?.("Token hết hạn (401) — đang refresh session… (~15s)");
        collector.invalidateAuth();
        const refreshed = await buildBaseAuth(onLog);
        collector = refreshed.collector;
        auth = await collector.collectAuth({ force: true });
        accountType = refreshed.accountType;
        collector.invalidateRecaptchaCache();
        continue;
      }
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isRecaptchaError(err)) {
        ensureNotCancelled(shouldCancel);
        collector.invalidateRecaptchaCache();
        // Escalation ladder: retry → clearStorage → restartBrowser.
        // `attempt` is 1-based and already incremented, so the NEXT
        // attempt number is what drives the escalation choice here.
        const nextAttempt = attempt + 1;
        if (nextAttempt === 3) {
          onLog?.("Google flag 403 UNUSUAL_ACTIVITY lần 2 — xóa site storage + reload tab…");
          await collector.clearSiteStorage(mode);
        } else if (nextAttempt === 4) {
          onLog?.("Google flag 403 UNUSUAL_ACTIVITY lần 3 — khởi động lại Chrome…");
          await collector.restartBrowser();
          // restartBrowser cleared auth; reload it from cache.
          const refreshed = await buildBaseAuth(onLog);
          collector = refreshed.collector;
          auth = refreshed.auth;
          accountType = refreshed.accountType;
        } else {
          onLog?.("Google flag 403 — thử lại với token mới…");
        }
        continue;
      }
      throw err;
    }
  }
}

export async function veoCreateImage(
  opts: Omit<
    CreateImageOptions,
    "recaptchaToken" | "accessToken" | "sessionId" | "projectId" | "cookie" | "accountType"
  >,
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<{ raw: GeneratedImage[] }> {
  ensureNotCancelled(shouldCancel);
  // R2 — when VEO_IMAGE_BATCH=1, coalesce concurrent callers into a single
  // batchGenerateImages API call (one reCAPTCHA for N prompts). The batcher
  // internally manages auth/reCAPTCHA/demux + falls back to individual calls
  // when the response can't be safely split.
  if (readBatcherConfig().enabled) {
    return getCreateImageBatcher().submit(opts, onLog, shouldCancel);
  }
  return withRecaptcha(async ({ recaptcha, auth: ctx, page }) => {
    const res = await timedSpan("veo.api.createImage", () =>
      requestCreateImageViaBrowser(page, {
        ...opts,
        recaptchaToken: recaptcha,
        accessToken: ctx.accessToken,
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        cookie: ctx.cookie,
        accountType: ctx.accountType,
      })
    );
    if (!res.ok) {
      const refCount = opts.referenceImages?.length ?? 0;
      let payloadDebug = "";
      try {
        const payload = buildCreateImagePayload({
          ...opts,
          recaptchaToken: recaptcha,
          accessToken: ctx.accessToken,
          sessionId: ctx.sessionId,
          projectId: ctx.projectId,
          cookie: ctx.cookie,
          accountType: ctx.accountType,
        });
        const sanitized = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
        const clientCtx = sanitized.clientContext as
          | { recaptchaContext?: { token?: string } }
          | undefined;
        if (clientCtx?.recaptchaContext?.token) {
          clientCtx.recaptchaContext.token = "<redacted>";
        }
        const reqs = sanitized.requests as Array<Record<string, unknown>> | undefined;
        reqs?.forEach((r) => {
          const inner = r.clientContext as { recaptchaContext?: { token?: string } } | undefined;
          if (inner?.recaptchaContext?.token) inner.recaptchaContext.token = "<redacted>";
        });
        payloadDebug = JSON.stringify(sanitized).slice(0, 1200);
      } catch {
        // ignore — the error message below is still useful without it.
      }
      if (payloadDebug) {
        onLog?.(`DEBUG payload gửi: ${payloadDebug}`);
      }
      // When the POST itself failed (status=0 + empty body), the only
      // useful piece of context is in `res.error` (e.g. "Target closed",
      // "timeout 60000ms exceeded", "ECONNRESET"). Without surfacing it
      // the user just sees "VEO createImage 0:" which is unactionable.
      const detail = res.body?.slice(0, 800) || res.error || "(no response body)";
      throw new Error(
        `VEO createImage ${res.status}${refCount ? ` (with ${refCount} reference image${refCount > 1 ? "s" : ""})` : ""}: ${detail}`
      );
    }
    onLog?.("Đã nhận kết quả ảnh.");
    return { raw: parseGeneratedImages(res.body) };
  }, "image", onLog, shouldCancel);
}

export async function veoUploadImage(
  opts: Omit<UploadImageOptions, "accessToken" | "sessionId" | "cookie">,
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<string> {
  ensureNotCancelled(shouldCancel);
  // Upload is usually a precursor to an I2V request, which will be sent
  // from the "video" tab. Routing the upload through the same tab keeps
  // the uploaded mediaId + the subsequent I2V token in a single
  // fingerprint session, mirroring the Python reference workflow.
  const { collector, auth } = await buildBaseAuth(onLog);
  ensureNotCancelled(shouldCancel);
  const page = await collector.getPageForMode("video");
  onLog?.("Đang upload ảnh tham chiếu lên VEO qua Chrome…");
  const res = await raceCancel(
    timedSpan("veo.api.uploadImage", () =>
      requestUploadUserImageViaBrowser(page, {
        ...opts,
        accessToken: auth.accessToken,
        sessionId: auth.sessionId,
        cookie: auth.cookie,
      }),
    ),
    shouldCancel,
  );
  if (!res.ok) {
    const detail = res.body?.slice(0, 400) || res.error || "(no response body)";
    throw new Error(`VEO uploadImage ${res.status}: ${detail}`);
  }
  const mediaId = parseUploadMediaId(res.body);
  if (!mediaId) throw new Error(`Không parse được mediaId từ response: ${res.body.slice(0, 300)}`);
  onLog?.("Upload ảnh OK.");
  return mediaId;
}

export async function veoTextToVideo(
  opts: Omit<
    T2VCreateOptions,
    "recaptchaToken" | "accessToken" | "sessionId" | "projectId" | "cookie" | "accountType"
  >,
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<{ operations: OperationRef[] }> {
  return withRecaptcha(async ({ recaptcha, auth: ctx, page }) => {
    const res = await timedSpan("veo.api.t2v", () =>
      requestCreateT2VViaBrowser(page, {
        ...opts,
        recaptchaToken: recaptcha,
        accessToken: ctx.accessToken,
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        cookie: ctx.cookie,
        accountType: ctx.accountType,
      })
    );
    if (!res.ok) {
      const detail = res.body?.slice(0, 400) || res.error || "(no response body)";
      throw new Error(`VEO t2v create ${res.status}: ${detail}`);
    }
    onLog?.("Request tạo video đã gửi. Đang chờ VEO xử lý…");
    return { operations: parseOperationsFromCreateResponse(res.body) };
  }, "video", onLog, shouldCancel);
}

export async function veoImageToVideo(
  opts: Omit<
    I2VCreateOptions,
    "recaptchaToken" | "accessToken" | "sessionId" | "projectId" | "cookie" | "accountType"
  >,
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<{ operations: OperationRef[] }> {
  return withRecaptcha(async ({ recaptcha, auth: ctx, page }) => {
    void buildI2VPayload({
      ...opts,
      recaptchaToken: recaptcha,
      accessToken: ctx.accessToken,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      cookie: ctx.cookie,
      accountType: ctx.accountType,
    });
    const res = await timedSpan("veo.api.i2v", () =>
      requestCreateI2VViaBrowser(page, {
        ...opts,
        recaptchaToken: recaptcha,
        accessToken: ctx.accessToken,
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
        cookie: ctx.cookie,
        accountType: ctx.accountType,
      })
    );
    if (!res.ok) {
      const detail = res.body?.slice(0, 400) || res.error || "(no response body)";
      throw new Error(`VEO i2v create ${res.status}: ${detail}`);
    }
    onLog?.("Request tạo video (I2V) đã gửi. Đang chờ VEO xử lý…");
    return { operations: parseOperationsFromCreateResponse(res.body) };
  }, "video", onLog, shouldCancel);
}

export interface PollResult {
  entries: StatusEntry[];
  finishedAll: boolean;
}

export async function veoPollStatus(operations: OperationRef[]): Promise<PollResult> {
  let { collector, auth } = await buildBaseAuth();
  let attempt = 0;
  while (true) {
    attempt++;
    const { http, entries } = await timedSpan("veo.api.pollStatus", () =>
      requestCheckStatus(operations, auth.accessToken, auth.sessionId, auth.cookie)
    );
    if (!http.ok) {
      if (attempt < 2 && http.status === 401) {
        collector.invalidateAuth();
        const refreshed = await buildBaseAuth();
        collector = refreshed.collector;
        auth = await collector.collectAuth({ force: true });
        continue;
      }
      throw new Error(`VEO pollStatus ${http.status}: ${http.body.slice(0, 300)}`);
    }
    const finishedAll = entries.every(
      (e) => Boolean(e.videoUrl) || /FAILED|ERROR/i.test(e.status || "")
    );
    return { entries, finishedAll };
  }
}

/**
 * Poll until all operations are done. Progress callback feeds SSE.
 */
export async function veoWaitForVideos(
  operations: OperationRef[],
  onProgress?: (entries: StatusEntry[]) => void,
  opts?: { intervalMs?: number; timeoutMs?: number; shouldCancel?: ShouldCancel }
): Promise<StatusEntry[]> {
  const { intervalMs = 4000, timeoutMs = 15 * 60_000, shouldCancel } = opts || {};
  const deadline = Date.now() + timeoutMs;
  let last: StatusEntry[] = [];
  while (Date.now() < deadline) {
    ensureNotCancelled(shouldCancel);
    const { entries, finishedAll } = await veoPollStatus(operations);
    last = entries;
    onProgress?.(entries);
    if (finishedAll) return entries;
    // Interruptible wait: cancel takes effect in ~200ms instead of
    // sitting through the full 4s poll interval.
    await cancelableSleep(intervalMs, shouldCancel);
  }
  throw new Error("VEO poll timeout");
}

export { downloadToDisk as veoDownload };
