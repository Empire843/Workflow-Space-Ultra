import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { request } from "undici";

import { GROK_PROFILE_NAME, ensureDirs } from "../../config";
import { resolveDownloadDir } from "../../paths/workflowAssets";
import { timedSpan } from "../../telemetry/timing";
import { getGrokCollector, resetGrokCollector } from "../../tokens/grokTokenCollector";

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
 * Playwright's "target closed" family of errors all share some common
 * substrings. Matching them lets us react to "tab died during the call"
 * without having to pattern-match every exact Playwright version.
 */
function isPageClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    /Target page, context or browser has been closed/i.test(m) ||
    /Target closed/i.test(m) ||
    /page\.evaluate: (Target|Protocol|Connection)/i.test(m)
  );
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
    const page = await collector.getLivePage();

    try {
      if (!page.url().includes("grok.com")) {
        await page.goto("https://grok.com/imagine", { waitUntil: "domcontentloaded", timeout: 20_000 });
      }
    } catch (err) {
      throw new Error(`Không thể navigate tới grok.com: ${err instanceof Error ? err.message : err}`);
    }

    const statsig = await withTimeout(
      collector.autoDiscoverStatsig(),
      20_000,
      "Grok statsig discovery",
    );
    return { page, statsig };
  });
}

const GROK_TRANSIENT_MAX_ATTEMPTS = 3;

export async function grokT2V(
  opts: Omit<GrokT2VOptions, "statsigHeaders"> & { profileName?: string }
): Promise<GrokT2VResult> {
  type ReadyCtx = Awaited<ReturnType<typeof ensureGrokReady>>;
  let page: ReadyCtx["page"];
  let statsig: ReadyCtx["statsig"];
  try {
    ({ page, statsig } = await ensureGrokReady(opts.profileName));
  } catch (err) {
    resetGrokCollector();
    throw err;
  }

  const runOnce = (p: ReadyCtx["page"], s: ReadyCtx["statsig"]) =>
    timedSpan("grok.api.t2v", () => grokTextToVideo(p, { ...opts, statsigHeaders: s }));

  let lastResult: GrokT2VResult | null = null;
  for (let attempt = 1; attempt <= GROK_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runOnce(page, statsig);
      if (result.mediaUrl) return result;
      // 200 but no mediaUrl: if Grok backend hiccup (upsampler/internal)
      // retry with a small backoff; otherwise return as-is so the
      // caller can surface the specific rejection reason.
      lastResult = result;
      if (!isGrokTransientBackendError(result.convoError) || attempt === GROK_TRANSIENT_MAX_ATTEMPTS) {
        return result;
      }
      const delayMs = 4000 + Math.floor(Math.random() * 3000) * attempt;
      opts.onProgress?.({ progress: 0, videoUrl: null, parentPostId: result.parentPostId });
      await new Promise((r) => setTimeout(r, delayMs));
      // Refresh the page/statsig before retrying — some upsampler
      // failures correlate with a stale statsig token.
      try {
        ({ page, statsig } = await ensureGrokReady(opts.profileName));
      } catch {
        // keep old page/statsig; next attempt will try with what we have
      }
      continue;
    } catch (err) {
      // A tab dying mid-call should not require a full Chrome restart —
      // the browser + login are still good. Swap in a fresh page from the
      // same context and retry once. Only fall back to resetGrokCollector
      // if that retry also fails (or if the failure is not page-related).
      if (isPageClosedError(err) && attempt < GROK_TRANSIENT_MAX_ATTEMPTS) {
        try {
          ({ page, statsig } = await ensureGrokReady(opts.profileName));
          continue;
        } catch (retryErr) {
          resetGrokCollector();
          throw retryErr;
        }
      }
      if (err instanceof Error && /timeout|not ready|login|session|disconnect/i.test(err.message)) {
        resetGrokCollector();
      }
      throw err;
    }
  }
  // Shouldn't reach here, but just in case:
  return lastResult as GrokT2VResult;
}

export async function grokI2V(
  opts: Omit<GrokI2VOptions, "statsigHeaders" | "parentPostId" | "parentMediaUrl"> & {
    profileName?: string;
  },
) {
  const runPipeline = async (page: import("playwright").Page, statsig: import("../../tokens/grokTokenCollector").GrokHeaders) => {
    // Pipeline step 2: create the image post from fileUri before calling convo.
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

  type ReadyCtx = Awaited<ReturnType<typeof ensureGrokReady>>;
  let page: ReadyCtx["page"];
  let statsig: ReadyCtx["statsig"];
  try {
    ({ page, statsig } = await ensureGrokReady(opts.profileName));
  } catch (err) {
    resetGrokCollector();
    throw err;
  }

  let lastResult: Awaited<ReturnType<typeof runPipeline>> | null = null;
  for (let attempt = 1; attempt <= GROK_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runPipeline(page, statsig);
      if (result.mediaUrl) return result;
      lastResult = result;
      // Transient Grok backend (e.g. "I2V Video prompt upsampling
      // failed: Upsampler returned empty response") — retry with a
      // fresh page + statsig. Policy rejections are NOT retried; see
      // isGrokTransientBackendError for the exclusion list.
      if (!isGrokTransientBackendError(result.convoError) || attempt === GROK_TRANSIENT_MAX_ATTEMPTS) {
        return result;
      }
      const delayMs = 4000 + Math.floor(Math.random() * 3000) * attempt;
      opts.onProgress?.({ progress: 0, videoUrl: null, parentPostId: null });
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        ({ page, statsig } = await ensureGrokReady(opts.profileName));
      } catch {
        // keep old page/statsig; next attempt uses what we have
      }
      continue;
    } catch (err) {
      // Same page-stale recovery as grokT2V — preserve the Chrome login,
      // grab a fresh page, retry once. Matches the symptom "trang Grok
      // vẫn còn mở nhưng page.evaluate báo Target closed".
      if (isPageClosedError(err) && attempt < GROK_TRANSIENT_MAX_ATTEMPTS) {
        try {
          ({ page, statsig } = await ensureGrokReady(opts.profileName));
          continue;
        } catch (retryErr) {
          resetGrokCollector();
          throw retryErr;
        }
      }
      if (err instanceof Error && /timeout|not ready|login|session|disconnect/i.test(err.message)) {
        resetGrokCollector();
      }
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
  const once = async () => {
    const { page, statsig } = await ensureGrokReady(opts.profileName);
    return timedSpan("grok.api.upload", () =>
      grokUploadImage(page, { ...opts, statsigHeaders: statsig })
    );
  };
  try {
    return await once();
  } catch (err) {
    if (isPageClosedError(err)) return await once();
    throw err;
  }
}

export async function grokUpscaleVideo(opts: { videoId: string; profileName?: string }) {
  const { page, statsig } = await ensureGrokReady(opts.profileName);
  return timedSpan("grok.api.upscale", () =>
    grokUpscale(page, { videoId: opts.videoId, statsigHeaders: statsig })
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
