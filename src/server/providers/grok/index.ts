import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { request } from "undici";

import { GROK_PROFILE_NAME, ensureDirs } from "../../config";
import { resolveDownloadDir } from "../../paths/workflowAssets";
import { timedSpan } from "../../telemetry/timing";
import {
  getGrokCollector,
  resetGrokCollector,
  type GrokTokenCollector,
  type GrokHeaders,
} from "../../tokens/grokTokenCollector";
import { sessionTelemetry } from "../../tokens/sessionTelemetry";

import {
  isGrokCdpDeadError,
  isGrokPageClosedError,
  isGrokUnauthenticated,
} from "./errors";

import {
  grokCreateImagePost,
  grokImageToVideo,
  grokUploadImage,
  grokUpscale,
  type GrokI2VOptions,
} from "./imageToVideo";
import { GROK_ASSETS_BASE } from "./constants";
import { grokTextToVideo, type GrokT2VOptions, type GrokT2VResult } from "./textToVideo";

export * from "./constants";
export * from "./textToVideo";
export * from "./imageToVideo";

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout sau ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Back-compat alias used by a few call-sites below — delegates to the
 * canonical classifier in `./errors` so the pattern list stays in one
 * place.
 */
const isPageClosedError = isGrokPageClosedError;

/**
 * Decide whether we should actually tear down the singleton Grok
 * collector. Previously we reset on any message matching
 * `timeout|not ready|login|session|disconnect`, which nuked the Chrome
 * connection on transient network blips — the exact symptom users saw
 * where Grok would "need re-open" after a flaky 30s window.
 *
 * Now: reset only when the CDP connection is demonstrably dead (browser
 * disconnected, browser/context closed, etc.). Authentication problems
 * are handled by `withGrokAuthRetry` below without reaching for the
 * reset hammer.
 */
function shouldResetGrokSingleton(err: unknown, collector: GrokTokenCollector | null): boolean {
  if (!collector) return false;
  try {
    const browser = (collector as unknown as { browser?: { isConnected?: () => boolean } }).browser;
    if (browser && browser.isConnected && !browser.isConnected()) return true;
  } catch {
    // ignore — fall through to error-message heuristic
  }
  return isGrokCdpDeadError(err);
}

function resetGrokIfCdpDead(err: unknown, collector: GrokTokenCollector | null): void {
  if (!shouldResetGrokSingleton(err, collector)) return;
  sessionTelemetry.record({
    target: "grok",
    kind: "reset_collector",
    detail: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
  });
  resetGrokCollector();
}

/**
 * 401/403 retry ladder for Grok — mirror of VEO's `withRecaptcha`
 * behaviour (minus the reCAPTCHA ceremony, which Grok doesn't use).
 *
 * Attempt 1: run as-is with whatever headers `ensureGrokReady` returned.
 * Attempt 2 (only if err is unauthenticated): force a statsig refresh
 *   (`autoDiscoverStatsig({ force: true })`), reload `/imagine`, retry.
 * Attempt 3+ give up with the final error so the caller's own
 *   transient-retry loop (or the session-error dialog) takes over.
 *
 * `ensureReady` is passed in so each call site can reuse the page/
 * statsig handle between attempts instead of re-deriving them every
 * iteration.
 */
async function withGrokAuthRetry<T>(
  profileName: string | undefined,
  fn: (ctx: { page: import("playwright").Page; statsig: GrokHeaders }) => Promise<T>,
  opts?: { maxAttempts?: number; label?: string },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 2;
  const label = opts?.label || "grok.call";
  let ctx = await ensureGrokReady(profileName);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(ctx);
    } catch (err) {
      const isAuth = isGrokUnauthenticated(err);
      if (!isAuth || attempt >= maxAttempts) throw err;
      sessionTelemetry.record({
        target: "grok",
        kind: "retry_401",
        detail: `${label} attempt=${attempt} ${err instanceof Error ? err.message.slice(0, 120) : ""}`,
      });
      // Force-refresh statsig; the page may already be on /imagine, but we
      // navigate again to replay the request listener that captures the new
      // header. Failure here falls through and the next attempt will retry
      // with the old context.
      try {
        const collector = await getGrokCollector(profileName || GROK_PROFILE_NAME);
        await collector.autoDiscoverStatsig({ force: true });
        ctx = await ensureGrokReady(profileName);
      } catch (refreshErr) {
        // If refresh itself throws auth too, don't loop forever — surface
        // the ORIGINAL error so the classifier sees "401" not "refresh failed".
        if (isGrokUnauthenticated(refreshErr)) throw err;
        throw refreshErr;
      }
    }
  }
  // unreachable — the loop always returns or throws
  throw new Error(`${label}: exhausted auth retries`);
}

/**
 * Did Grok's backend itself fail transiently? Unlike page-closed
 * errors (Playwright side) or content-policy (user side), these are
 * server-side blips that usually clear in a few seconds — worth a
 * retry or two before surfacing to the user.
 *
 * Signals (seen in grokSays / convoError diagnostics):
 *   - "Upsampler returned empty response"  (prompt upsampler timeout)
 *   - "I2V Video prompt upsampling failed"
 *   - "internal error" / "internal_error"
 *   - "service unavailable" / "temporarily unavailable"
 *   - "try again" (Grok's own polite phrasing for capacity issues)
 *
 * Explicit NON-match (do NOT retry): "silentRejection=true",
 * "moderation=", "finishReason=SAFETY", "content policy", any
 * "can't/cannot create" text — those are policy refusals; retrying
 * won't help and we'd just waste tokens + time.
 */
function isGrokTransientBackendError(convoError?: string | null): boolean {
  if (!convoError) return false;
  const m = convoError.toLowerCase();
  if (
    m.includes("silentrejection=true") ||
    m.includes("hallucinatedsuccess=true") ||
    m.includes("moderation=") ||
    m.includes("finishreason=safety") ||
    m.includes("finishreason=recitation") ||
    m.includes("content policy") ||
    m.includes("can't create") ||
    m.includes("cannot create") ||
    m.includes("not allowed")
  ) {
    return false;
  }
  return (
    m.includes("upsampler") ||
    m.includes("upsampling") ||
    m.includes("internal error") ||
    m.includes("internal_error") ||
    m.includes("service unavailable") ||
    m.includes("temporarily unavailable") ||
    m.includes("try again")
  );
}

/**
 * Pre-flight: confirm Chrome still has a login cookie for grok.com.
 *
 * Without this, a logged-out profile would silently limp along —
 * `autoDiscoverStatsig` may still capture a header from the anonymous
 * landing page, but every subsequent POST returns 401, which looked to
 * the user like "Grok is broken again". Now we throw a Grok-classified
 * error BEFORE the HTTP call, so the session-error dialog fires
 * immediately.
 *
 * Tolerant of cookie naming drift: Grok has used `sso`, `sso-rw`, and
 * more recently split auth across several cookies; any reasonably-sized
 * cookie on the domain counts as "logged in" for this quick gate.
 */
async function verifyGrokSessionCookie(page: import("playwright").Page): Promise<void> {
  let cookies: Array<{ name: string; value: string }>;
  try {
    cookies = await page
      .context()
      .cookies(["https://grok.com", "https://www.grok.com"]);
  } catch {
    return; // if cookie read itself fails, downstream auth retry will catch it
  }
  if (!cookies.length) {
    sessionTelemetry.record({
      target: "grok",
      kind: "preflight_fail",
      detail: "no cookies for grok.com",
    });
    throw new Error(
      "Grok session: Chrome Grok chưa login (không tìm thấy cookie của grok.com). Hãy mở Chrome Grok và đăng nhập Super Grok Heavy trước khi chạy.",
    );
  }
  // Grok rotates cookie names every few months (we've seen `sso`, `sso-rw`,
  // `xai-session-*`, etc.) so a name-based whitelist false-positives the
  // moment they ship a redesign and bricks every job until we ship a new
  // build. Any cookie value >= 24 chars on grok.com is overwhelmingly
  // likely to be an opaque session/JWT token — guest cookies and feature
  // flags rarely cross that bar. We keep the strict "no cookies at all"
  // short-circuit above to still catch the actually-logged-out case.
  const AUTH_VALUE_MIN = 24;
  const hasAuthish = cookies.some((c) => {
    if (!c.value) return false;
    return c.value.length >= AUTH_VALUE_MIN;
  });
  if (!hasAuthish) {
    const names = cookies.map((c) => c.name).join(",");
    sessionTelemetry.record({
      target: "grok",
      kind: "preflight_fail",
      detail: `no auth-ish cookie (have: ${names.slice(0, 120)})`,
    });
    throw new Error(
      "Grok session: Chrome Grok không có cookie đăng nhập (có thể đã bị logout hoặc cookie hết hạn). Mở lại grok.com và login lại.",
    );
  }
}

async function ensureGrokReady(profileName?: string) {
  return timedSpan("grok.ensureReady", async () => {
    const name = profileName || GROK_PROFILE_NAME;
    const collector = await withTimeout(
      getGrokCollector(name),
      30_000,
      "Grok Chrome connect",
    );
    // `getLivePage()` self-heals a dead page handle: if the user closed
    // the tab we cached at init() but the browser window is still open,
    // it reclaims another grok.com tab or opens a fresh one. Without
    // this, every subsequent call failed with
    //   "page.evaluate: Target page, context or browser has been closed"
    // even though the Grok window was visibly still there.
    let page = await collector.getLivePage();

    // Navigation retry: grok.com/imagine may fail transiently due to
    // redirects (ERR_ABORTED), context destruction (VEO cross-contamination),
    // or network timeouts. Retry up to 3 times with backoff + fresh page.
    for (let navAttempt = 1; navAttempt <= 3; navAttempt++) {
      try {
        const currentUrl = (() => { try { return page.url(); } catch { return ""; } })();
        if (!currentUrl.includes("grok.com")) {
          await page.goto("https://grok.com/imagine", {
            waitUntil: "domcontentloaded",
            timeout: 25_000,
          });
        }
        break; // success
      } catch (err) {
        if (navAttempt >= 3) {
          throw new Error(
            `Không thể navigate tới grok.com (attempt ${navAttempt}/3): ${err instanceof Error ? err.message : err}`,
          );
        }
        console.warn(
          `[Grok] Navigation attempt ${navAttempt}/3 failed: ${err instanceof Error ? err.message : err}`,
        );
        await new Promise((r) => setTimeout(r, 2000 * navAttempt));
        page = await collector.getLivePage(); // get fresh page handle
      }
    }

    // Fast-fail if the profile is logged out — surfaces a clear "mở Chrome
    // Grok và login" message instead of a cryptic 401 downstream.
    await Promise.race([
      verifyGrokSessionCookie(page),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);

    const statsigStarted = Date.now();
    let statsig: GrokHeaders;
    try {
      statsig = await withTimeout(
        collector.autoDiscoverStatsig(),
        20_000,
        "Grok statsig discovery",
      );
      sessionTelemetry.record({
        target: "grok",
        kind: "collect_ok",
        durationMs: Date.now() - statsigStarted,
      });
    } catch (err) {
      sessionTelemetry.record({
        target: "grok",
        kind: "collect_fail",
        durationMs: Date.now() - statsigStarted,
        detail: err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180),
      });
      throw err;
    }
    return { page, statsig };
  });
}

const GROK_TRANSIENT_MAX_ATTEMPTS = 3;

export async function grokT2V(
  opts: Omit<GrokT2VOptions, "statsigHeaders"> & { profileName?: string }
): Promise<GrokT2VResult> {
  const runOnceUnderAuth = () =>
    withGrokAuthRetry(
      opts.profileName,
      ({ page, statsig }) =>
        timedSpan("grok.api.t2v", () => grokTextToVideo(page, { ...opts, statsigHeaders: statsig })),
      { label: "grok.t2v" },
    );

  let lastResult: GrokT2VResult | null = null;
  for (let attempt = 1; attempt <= GROK_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runOnceUnderAuth();
      if (result.mediaUrl) return result;
      // 200 but no mediaUrl — Grok backend blip; retry a couple of times
      // with fresh page/statsig. Policy refusals fall through unchanged.
      lastResult = result;
      if (!isGrokTransientBackendError(result.convoError) || attempt === GROK_TRANSIENT_MAX_ATTEMPTS) {
        return result;
      }
      const delayMs = 4000 + Math.floor(Math.random() * 3000) * attempt;
      opts.onProgress?.({ progress: 0, videoUrl: null, parentPostId: result.parentPostId });
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    } catch (err) {
      // Page/tab died but Chrome is alive — withGrokAuthRetry already
      // refreshes the page on auth errors; a plain page-closed from a
      // crashed renderer just needs another ensureGrokReady.
      if (isPageClosedError(err) && attempt < GROK_TRANSIENT_MAX_ATTEMPTS) {
        try {
          await ensureGrokReady(opts.profileName);
          continue;
        } catch (retryErr) {
          resetGrokIfCdpDead(retryErr, null);
          throw retryErr;
        }
      }
      // Only reset the singleton when CDP is actually dead — transient
      // 401/timeout no longer nukes the Chrome connection.
      resetGrokIfCdpDead(err, null);
      throw err;
    }
  }
  return lastResult as GrokT2VResult;
}

export async function grokI2V(
  opts: Omit<GrokI2VOptions, "statsigHeaders" | "parentPostId" | "parentMediaUrl"> & {
    profileName?: string;
  },
) {
  const runPipeline = async (page: import("playwright").Page, statsig: GrokHeaders) => {
    const rawUri = (opts.fileUri || "").trim();
    const assetUrl = rawUri.startsWith("http")
      ? rawUri
      : `${GROK_ASSETS_BASE}/${rawUri.replace(/^\//, "")}`;
    const post = await timedSpan("grok.api.createPost", () =>
      grokCreateImagePost(page, { mediaUrl: assetUrl, statsigHeaders: statsig })
    );

    return await timedSpan("grok.api.i2v", () =>
      grokImageToVideo(page, {
        ...opts,
        parentPostId: post.postId,
        parentMediaUrl: post.mediaUrl,
        statsigHeaders: statsig,
      })
    );
  };

  const runOnceUnderAuth = () =>
    withGrokAuthRetry(
      opts.profileName,
      ({ page, statsig }) => runPipeline(page, statsig),
      { label: "grok.i2v" },
    );

  let lastResult: Awaited<ReturnType<typeof runPipeline>> | null = null;
  for (let attempt = 1; attempt <= GROK_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runOnceUnderAuth();
      if (result.mediaUrl) return result;
      lastResult = result;
      if (!isGrokTransientBackendError(result.convoError) || attempt === GROK_TRANSIENT_MAX_ATTEMPTS) {
        return result;
      }
      const delayMs = 4000 + Math.floor(Math.random() * 3000) * attempt;
      opts.onProgress?.({ progress: 0, videoUrl: null, parentPostId: null });
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    } catch (err) {
      if (isPageClosedError(err) && attempt < GROK_TRANSIENT_MAX_ATTEMPTS) {
        try {
          await ensureGrokReady(opts.profileName);
          continue;
        } catch (retryErr) {
          resetGrokIfCdpDead(retryErr, null);
          throw retryErr;
        }
      }
      resetGrokIfCdpDead(err, null);
      throw err;
    }
  }
  return lastResult as Awaited<ReturnType<typeof runPipeline>>;
}

export async function grokUpload(opts: {
  base64: string;
  fileName: string;
  mimeType: string;
  profileName?: string;
}) {
  try {
    return await withGrokAuthRetry(
      opts.profileName,
      ({ page, statsig }) =>
        timedSpan("grok.api.upload", () =>
          grokUploadImage(page, { ...opts, statsigHeaders: statsig }),
        ),
      { label: "grok.upload" },
    );
  } catch (err) {
    // Transient tab-closed failure — rebuild ready context and retry once.
    // Auth failures are already handled inside withGrokAuthRetry.
    if (isPageClosedError(err)) {
      return await withGrokAuthRetry(
        opts.profileName,
        ({ page, statsig }) =>
          timedSpan("grok.api.upload.retry", () =>
            grokUploadImage(page, { ...opts, statsigHeaders: statsig }),
          ),
        { label: "grok.upload.retry", maxAttempts: 1 },
      );
    }
    resetGrokIfCdpDead(err, null);
    throw err;
  }
}

export async function grokUpscaleVideo(opts: { videoId: string; profileName?: string }) {
  return withGrokAuthRetry(
    opts.profileName,
    ({ page, statsig }) =>
      timedSpan("grok.api.upscale", () =>
        grokUpscale(page, { videoId: opts.videoId, statsigHeaders: statsig }),
      ),
    { label: "grok.upscale" },
  );
}

/**
 * Download a video from assets.grok.com to disk. Cookies/session are sent by the page — so download via page.request.
 */
export async function grokDownloadVideo(
  url: string,
  fileName: string,
  profileName?: string,
  workflowRunId?: string | null,
): Promise<string> {
  return timedSpan("grok.download", async () => {
    ensureDirs();
    const { dir } = resolveDownloadDir(workflowRunId);
    await mkdir(dir, { recursive: true });
    const abs = path.join(dir, fileName);
    const { page } = await ensureGrokReady(profileName);

    // R1.4 — stream via undici with browser cookies so the body is never
    // held entirely in memory. Previously used `page.request.get → resp.body()`
    // which buffers the whole ~30MB clip before writing to disk, spiking RAM
    // when many Grok jobs finish in parallel.
    const cookies = await page.context().cookies(["https://grok.com", "https://assets.grok.com"]);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { body, statusCode } = await request(url, {
          method: "GET",
          headers: cookieHeader
            ? {
              cookie: cookieHeader,
              "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            }
            : {},
          bodyTimeout: 60_000,
          headersTimeout: 30_000,
        });
        if (statusCode < 200 || statusCode >= 300) {
          throw new Error(`download status ${statusCode}`);
        }
        const out = createWriteStream(abs);
        await finished(Readable.from(body).pipe(out));
        return abs;
      } catch (err) {
        console.warn(
          `[Grok download] attempt ${attempt}/3 (stream) failed:`,
          err instanceof Error ? err.message : err
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    // Last-chance fallback: Playwright page.request (buffered) — used when
    // assets.grok.com's TLS / SNI flow doesn't match undici defaults.
    try {
      const resp = await page.request.get(url, { timeout: 60_000 });
      if (resp.ok()) {
        const buf = await resp.body();
        await new Promise<void>((resolve, reject) => {
          const out = createWriteStream(abs);
          out.on("error", reject);
          out.on("finish", () => resolve());
          out.end(buf);
        });
        return abs;
      }
    } catch { /* ignore */ }

    throw new Error(`Grok download failed sau 3 lần thử. URL: ${url}`);
  });
}

/**
 * Proxy download via the Playwright page (using Grok session cookies).
 * Used by /api/download when the URL is assets.grok.com.
 */
export async function grokProxyFetch(
  url: string,
  profileName?: string,
): Promise<{ body: Buffer; contentType: string; status: number }> {
  const { page } = await ensureGrokReady(profileName);
  const resp = await page.request.get(url, { timeout: 60_000 });
  return {
    body: await resp.body(),
    contentType: resp.headers()["content-type"] || "application/octet-stream",
    status: resp.status(),
  };
}
