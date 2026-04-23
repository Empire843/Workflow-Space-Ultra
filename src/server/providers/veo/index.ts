import type { Page } from "playwright";

import { loadConfig, type AccountType } from "../../config";
import { timedSpan } from "../../telemetry/timing";
import { sessionTelemetry } from "../../tokens/sessionTelemetry";
import { getVeoCollector, type VeoTokenCollector } from "../../tokens/veoTokenCollector";
import {
  cancelableSleep,
  ensureNotCancelled,
  raceCancel,
  type ShouldCancel,
} from "../cancellation";

import { getCreateImageBatcher, readBatcherConfig } from "./batcher";
import { bumpAndMaybeClear, preCaptureJitter } from "./captureCounter";
import { cooldownRemainingMs, recordRecaptchaStrike, waitForCooldown } from "./cooldown";
import {
  isRecaptchaCaptureTimeout,
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

/**
 * Peek at the VEO auth tab's current URL and raise a VEO-classified error
 * BEFORE we try to extract tokens. Previously, if Chrome had been logged
 * out of Google (or the user closed the Flow project tab), `collectAuth`
 * would wait the full timeout for listeners that never fire, then throw a
 * generic "Timeout chờ session/projectId/accessToken". This version trips
 * early with a message the session-error classifier picks up as `veo`,
 * so the dialog appears immediately and the user knows exactly which
 * Chrome needs attention.
 *
 * Only warns when we have a concrete signal — navigation is deferred to
 * the token collector itself. The 5s ceiling keeps this step
 * imperceptible when things are fine.
 */
async function verifyVeoPageAccessible(
  collector: VeoTokenCollector,
  onLog?: LogFn,
): Promise<void> {
  const page = collector.getPage?.();
  if (!page) return; // nothing to check yet; collector will bootstrap it
  let url = "";
  try {
    url = page.url() || "";
  } catch {
    return;
  }
  // Google's "signed out" landing page — plain `accounts.google.com` or
  // `/ServiceLogin` shows up here when the profile's cookie got revoked.
  if (/accounts\.google\.com\/ServiceLogin|\/logout|signin/i.test(url)) {
    sessionTelemetry.record({
      target: "veo",
      kind: "preflight_fail",
      detail: `redirected to ${url.slice(0, 120)}`,
    });
    onLog?.("Chrome VEO đã bị đăng xuất — cần login lại.");
    throw new Error(
      `VEO session: Chrome đã bị đăng xuất khỏi Google Flow (URL hiện tại: ${url.slice(0, 80)}…). Hãy mở lại Chrome VEO và đăng nhập trước khi chạy.`,
    );
  }
  // If we've been redirected outside labs.google entirely (e.g. the user
  // navigated away and nothing we control is still open), trip early.
  if (url && !/about:|chrome:|labs\.google/i.test(url)) {
    sessionTelemetry.record({
      target: "veo",
      kind: "preflight_fail",
      detail: `off-site url ${url.slice(0, 120)}`,
    });
    onLog?.("Tab VEO không còn ở Google Flow — session có thể đã hết hạn.");
    throw new Error(
      `VEO session: Tab Chrome không ở labs.google nữa (URL: ${url.slice(0, 80)}…). Mở lại Chrome VEO rồi thử lại.`,
    );
  }
}

async function buildBaseAuth(onLog?: LogFn, shouldCancel?: ShouldCancel) {
  return timedSpan("veo.buildAuth", async () => {
    onLog?.("Kết nối VEO session…");
    // Race everything that can hang on Playwright against the cancel
    // signal. Previously a stuck `getVeoCollector` / `collectAuth` call
    // could pin a job in "running" state for the full ~30-60s Chrome
    // boot even after the user hit cancel.
    const collector = await raceCancel(getVeoCollector(), shouldCancel);
    // Race the pre-flight check against a 5s budget so we don't add
    // perceptible latency when things are fine.
    await raceCancel(
      Promise.race([
        verifyVeoPageAccessible(collector, onLog),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]),
      shouldCancel,
    );
    const collectStarted = Date.now();
    let auth;
    try {
      auth = await raceCancel(collector.collectAuth(), shouldCancel);
      sessionTelemetry.record({
        target: "veo",
        kind: "collect_ok",
        durationMs: Date.now() - collectStarted,
      });
    } catch (err) {
      sessionTelemetry.record({
        target: "veo",
        kind: "collect_fail",
        durationMs: Date.now() - collectStarted,
        detail: err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180),
      });
      throw err;
    }
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
 * (`A_workflow_text_to_video.py` lines 481-542). Every 403 branch also
 * calls `recordRecaptchaStrike()` so the lane-wide cooldown kicks in for
 * ALL concurrent VEO callers, not just the one that caught this error.
 * Without the shared cooldown, N parallel `gen.image` jobs would each
 * run their own 4-attempt escalation ladder independently — 4 × 4 = 16
 * more requests aimed at an account Google has already flagged. The
 * debounce inside `recordRecaptchaStrike` makes concurrent 403s from
 * the same burst count as a single strike.
 */

const MAX_RECAPTCHA_ATTEMPTS = 4;

interface RecaptchaCtx {
  recaptcha: string;
  auth: AuthCtx;
  page: Page;
  collector: VeoTokenCollector;
}

/**
 * Base inter-request spacing (ms). A timing-jitter is applied on top (±
 * `VEO_THROTTLE_JITTER_MS`) so consecutive submissions don't land on
 * exact 20_000ms boundaries — one of the "too-regular" signals
 * reCAPTCHA Enterprise uses to score traffic as non-human.
 *
 * Overridable via `VEO_THROTTLE_MS` (default 20_000) and
 * `VEO_THROTTLE_JITTER_MS` (default 2_500 → ±2.5s window).
 */
const VEO_THROTTLE_BASE_MS_DEFAULT = 20_000;
const VEO_THROTTLE_JITTER_DEFAULT = 2_500;

function readThrottleBaseMs(): number {
  const raw = Number(process.env.VEO_THROTTLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : VEO_THROTTLE_BASE_MS_DEFAULT;
}

function readThrottleJitterMs(): number {
  const raw = Number(process.env.VEO_THROTTLE_JITTER_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : VEO_THROTTLE_JITTER_DEFAULT;
}

/**
 * Compute a single throttle slot duration with ±jitter. Used both when
 * scheduling ourselves behind an existing slot and when initialising
 * `nextReadyMs` from scratch. Kept deterministic per call so concurrent
 * submitters see a consistent number when reading the same invocation.
 */
function throttleSlotMs(): number {
  const base = readThrottleBaseMs();
  const jitter = readThrottleJitterMs();
  if (jitter <= 0) return base;
  const delta = Math.floor((Math.random() * 2 - 1) * jitter);
  const slot = base + delta;
  return slot < 1_000 ? 1_000 : slot; // clamp to a sane floor
}

interface ThrottleState { nextReadyMs: number; }
function getThrottleState(): ThrottleState {
  const g = globalThis as any;
  if (!g.__wsu_veo_throttle__) g.__wsu_veo_throttle__ = { nextReadyMs: 0 };
  return g.__wsu_veo_throttle__;
}

async function waitVeoThrottle(onLog?: LogFn, shouldCancel?: ShouldCancel) {
  const st = getThrottleState();
  const now = Date.now();

  let myWait = 0;
  // Synchronous atomic state update
  const slot = throttleSlotMs();
  if (st.nextReadyMs > now) {
    myWait = st.nextReadyMs - now;
    st.nextReadyMs = st.nextReadyMs + slot;
  } else {
    st.nextReadyMs = now + slot;
  }

  if (myWait > 0) {
    const delayS = (myWait / 1000).toFixed(1);
    onLog?.(`[Rate Limit] Tránh đánh dồn dập: xếp hàng đợi ${delayS}s trước khi gửi VEO…`);
    await cancelableSleep(myWait, shouldCancel);
  }
}

// Periodic proactive clear + pre-capture jitter helpers live in
// `./captureCounter.ts` so the batcher can call them too without
// importing this module (avoids an import cycle with `./batcher.ts`).

async function withRecaptcha<T>(
  fn: (ctx: RecaptchaCtx) => Promise<T>,
  mode: "video" | "image" = "video",
  onLog?: LogFn,
  shouldCancel?: ShouldCancel,
): Promise<T> {
  ensureNotCancelled(shouldCancel);
  let { collector, auth, accountType } = await buildBaseAuth(onLog, shouldCancel);
  let attempt = 0;
  while (true) {
    attempt++;
    ensureNotCancelled(shouldCancel);

    // Safety-net cooldown only. Happy path never writes to it; if it's set,
    // safety-net cooldown kicks in)
    if (cooldownRemainingMs() > 0) {
      await waitForCooldown(onLog, shouldCancel);
    }

    // Rate-limit consecutive requests to prevent spamming Google.
    // We only wait the main throttle line on attempt 1.
    if (attempt === 1) {
      await waitVeoThrottle(onLog, shouldCancel);
      // Periodic proactive storage clear — runs ONCE per user-visible
      // submission, not on every retry (each retry already drags the
      // account through one burst; piling a clear on top would only
      // pad latency). Guarded inside bumpAndMaybeClear so it's a no-op
      // when the counter hasn't hit the cadence yet.
      await bumpAndMaybeClear(collector, mode, onLog, shouldCancel);
      // Human-pause jitter right before we trigger the Flow "Tạo"
      // button. Tiny cost (≤1s), meaningful risk-score improvement.
      await preCaptureJitter(shouldCancel);
    } else {
      // Human-like delay between retries
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
        collector.getFreshRecaptchaToken(
          { timeoutMs: 25_000, mode, shouldCancel },
          mode,
          shouldCancel,
        ),
      ),
      shouldCancel,
    );
    ensureNotCancelled(shouldCancel);
    onLog?.("reCAPTCHA OK. Đang gửi request qua Chrome…");
    const page = await raceCancel(collector.getPageForMode(mode), shouldCancel);
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
      // Capture-side recaptcha timeout: the Flow tab never fired
      // `/recaptcha/enterprise/reload` within our deadline. Most often
      // this is the cached tab being on the wrong URL / project page
      // even though `_getPageForMode` thought it was fine, OR a modal
      // intercepting the "Tạo" click. Either way, dropping the page
      // handle so the next attempt re-navigates to a known-good project
      // URL is the right fix — far cheaper than escalating to
      // clearStorage / restartBrowser. Auth tokens are NOT touched.
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isRecaptchaCaptureTimeout(err)) {
        ensureNotCancelled(shouldCancel);
        onLog?.(
          `Page Flow chưa trả recaptcha (mode=${mode}) — mở lại tab và thử lần ${attempt + 1}/${MAX_RECAPTCHA_ATTEMPTS}…`,
        );
        collector.invalidatePageForMode(mode);
        collector.invalidateRecaptchaCache();
        continue;
      }
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isUnauthenticated(err)) {
        ensureNotCancelled(shouldCancel);
        onLog?.("Token hết hạn (401) — đang refresh session… (~15s)");
        collector.invalidateAuth();
        // Drop the cached page handle for this mode too: a 401 typically
        // means Google bounced the tab to a sign-in / consent screen, so
        // its URL is no longer `labs.google/fx`. Without this, the next
        // iteration would race `_getPageForMode` against the stale tab,
        // recapture-timeout, and burn another retry slot.
        collector.invalidatePageForMode(mode);
        const refreshed = await buildBaseAuth(onLog, shouldCancel);
        collector = refreshed.collector;
        auth = await raceCancel(collector.collectAuth({ force: true }), shouldCancel);
        accountType = refreshed.accountType;
        collector.invalidateRecaptchaCache();
        continue;
      }
      if (attempt < MAX_RECAPTCHA_ATTEMPTS && isRecaptchaError(err)) {
        ensureNotCancelled(shouldCancel);
        collector.invalidateRecaptchaCache();
        // Shared cooldown for the whole VEO lane. Concurrent callers
        // that also hit a 403 in this burst get debounced to a single
        // strike, and every in-flight attempt (including this one's
        // next loop iteration) will block on `waitForCooldown` at the
        // top of the loop until Google's flag cools. Without this, 4
        // parallel jobs would each climb the retry ladder separately
        // and keep the account in the penalty box permanently.
        const cd = recordRecaptchaStrike();
        onLog?.(
          `Lane VEO cooldown ${(cd.delayMs / 1000).toFixed(0)}s (strike #${cd.strikes}) — ` +
            `đợi trước khi thử lại…`,
        );
        // Escalation ladder: retry → clearStorage → restartBrowser.
        // `attempt` is 1-based and already incremented, so the NEXT
        // attempt number is what drives the escalation choice here.
        const nextAttempt = attempt + 1;
        if (nextAttempt === 3) {
          onLog?.("Google flag 403 UNUSUAL_ACTIVITY lần 2 — xóa site storage + reload tab…");
          await raceCancel(collector.clearSiteStorage(mode), shouldCancel);
        } else if (nextAttempt === 4) {
          onLog?.("Google flag 403 UNUSUAL_ACTIVITY lần 3 — khởi động lại Chrome…");
          await raceCancel(collector.restartBrowser(), shouldCancel);
          // restartBrowser cleared auth AND wiped the `_pages` map, so we
          // don't need a separate `invalidatePageForMode(mode)` here —
          // the next `getPageForMode` will scan a brand-new context and
          // open a fresh tab anyway. Reload auth from cache.
          const refreshed = await buildBaseAuth(onLog, shouldCancel);
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

export async function veoPollStatus(
  operations: OperationRef[],
  shouldCancel?: ShouldCancel,
): Promise<PollResult> {
  let { collector, auth } = await buildBaseAuth(undefined, shouldCancel);
  let attempt = 0;
  while (true) {
    attempt++;
    ensureNotCancelled(shouldCancel);
    const { http, entries } = await raceCancel(
      timedSpan("veo.api.pollStatus", () =>
        requestCheckStatus(operations, auth.accessToken, auth.sessionId, auth.cookie),
      ),
      shouldCancel,
    );
    if (!http.ok) {
      if (attempt < 2 && http.status === 401) {
        collector.invalidateAuth();
        const refreshed = await buildBaseAuth(undefined, shouldCancel);
        collector = refreshed.collector;
        auth = await raceCancel(collector.collectAuth({ force: true }), shouldCancel);
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
    // Race the HTTP status poll against the cancel signal. Without this
    // wrap, a hung fetch to the VEO batch-check endpoint could block
    // cancellation for up to 15 minutes (the poll-level timeout) because
    // `requestCheckStatus` has no idea the user pressed cancel.
    const { entries, finishedAll } = await raceCancel(
      veoPollStatus(operations, shouldCancel),
      shouldCancel,
    );
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
