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

async function ensureGrokReady(profileName?: string) {
  return timedSpan("grok.ensureReady", async () => {
    const name = profileName || GROK_PROFILE_NAME;
    const collector = await withTimeout(
      getGrokCollector(name),
      30_000,
      "Grok Chrome connect",
    );
    const page = collector.getPage();
    if (!page) throw new Error("Grok page not ready — Chrome có thể chưa mở hoặc login chưa thành công");

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

export async function grokT2V(
  opts: Omit<GrokT2VOptions, "statsigHeaders"> & { profileName?: string }
): Promise<GrokT2VResult> {
  let page, statsig;
  try {
    ({ page, statsig } = await ensureGrokReady(opts.profileName));
  } catch (err) {
    resetGrokCollector();
    throw err;
  }
  try {
    return await timedSpan("grok.api.t2v", () =>
      grokTextToVideo(page, { ...opts, statsigHeaders: statsig })
    );
  } catch (err) {
    if (err instanceof Error && /timeout|not ready|login|session|closed|disconnect/i.test(err.message)) {
      resetGrokCollector();
    }
    throw err;
  }
}

export async function grokI2V(
  opts: Omit<GrokI2VOptions, "statsigHeaders" | "parentPostId" | "parentMediaUrl"> & {
    profileName?: string;
  },
) {
  let page, statsig;
  try {
    ({ page, statsig } = await ensureGrokReady(opts.profileName));
  } catch (err) {
    resetGrokCollector();
    throw err;
  }
  try {
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
  } catch (err) {
    if (err instanceof Error && /timeout|not ready|login|session|closed|disconnect/i.test(err.message)) {
      resetGrokCollector();
    }
    throw err;
  }
}

export async function grokUpload(opts: {
  base64: string;
  fileName: string;
  mimeType: string;
  profileName?: string;
}) {
  const { page, statsig } = await ensureGrokReady(opts.profileName);
  return timedSpan("grok.api.upload", () =>
    grokUploadImage(page, { ...opts, statsigHeaders: statsig })
  );
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
