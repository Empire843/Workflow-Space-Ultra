import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { request } from "undici";

import { DOWNLOADS_DIR, GROK_PROFILE_NAME, ensureDirs } from "../../config";
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
    return await grokTextToVideo(page, { ...opts, statsigHeaders: statsig });
  } catch (err) {
    if (err instanceof Error && /timeout|not ready|login|session/i.test(err.message)) {
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
    const post = await grokCreateImagePost(page, {
      mediaUrl: assetUrl,
      statsigHeaders: statsig,
    });

    return await grokImageToVideo(page, {
      ...opts,
      parentPostId: post.postId,
      parentMediaUrl: post.mediaUrl,
      statsigHeaders: statsig,
    });
  } catch (err) {
    if (err instanceof Error && /timeout|not ready|login|session/i.test(err.message)) {
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
  return grokUploadImage(page, { ...opts, statsigHeaders: statsig });
}

export async function grokUpscaleVideo(opts: { videoId: string; profileName?: string }) {
  const { page, statsig } = await ensureGrokReady(opts.profileName);
  return grokUpscale(page, { videoId: opts.videoId, statsigHeaders: statsig });
}

/**
 * Download a video from assets.grok.com to disk. Cookies/session are sent by the page — so download via page.request.
 */
export async function grokDownloadVideo(
  url: string,
  fileName: string,
  profileName?: string
): Promise<string> {
  ensureDirs();
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  const abs = path.join(DOWNLOADS_DIR, fileName);
  const { page } = await ensureGrokReady(profileName);

  // Retry up to 3 times because assets.grok.com sometimes needs time for CDN propagation
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await page.request.get(url, { timeout: 60_000 });
      if (!resp.ok()) throw new Error(`download status ${resp.status()}`);
      const buf = await resp.body();
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(abs);
        out.on("error", reject);
        out.on("finish", () => resolve());
        out.end(buf);
      });
      return abs;
    } catch (err) {
      console.warn(`[Grok download] attempt ${attempt}/3 failed:`, err instanceof Error ? err.message : err);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  // Fallback raw fetch (no cookies — may work for public CDN URLs)
  try {
    const { body, statusCode } = await request(url, { method: "GET" });
    if (statusCode >= 200 && statusCode < 300) {
      const out = createWriteStream(abs);
      await finished(Readable.from(body).pipe(out));
      return abs;
    }
  } catch { /* ignore fallback */ }

  throw new Error(`Grok download failed sau 3 lần thử. URL: ${url}`);
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
