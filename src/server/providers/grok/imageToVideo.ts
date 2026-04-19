import type { Page } from "playwright";

import type { GrokHeaders } from "../../tokens/grokTokenCollector";
import {
  DEFAULT_VIDEO_CONFIG,
  ENDPOINT_CONVO_NEW,
  ENDPOINT_CREATE_POST,
  ENDPOINT_UPLOAD_FILE,
  ENDPOINT_UPSCALE,
  GROK_ASSETS_BASE,
  UPLOAD_FILE_SOURCE,
  type GrokVideoConfig,
} from "./constants";

export interface GrokUploadResult {
  fileMetadataId: string;
  fileUri: string;
}

export interface GrokCreateImagePostResult {
  postId: string;
  mediaUrl: string;
}

/**
 * Step 2 of the Grok I2V pipeline: after uploading the image (fileUri available) we must
 * create an "Imagine post" from that image so it can be used as `parentPostId` for the
 * videoGen convo. If we skip this step and pass `fileMetadataId` as parentPostId,
 * Grok returns `404 Source post not found [WKE=imagine:invalid-parent-post]`.
 *
 * See Python reference: `api_create_image_post_in_page` in
 * `grok_api_image_to_video.py`.
 */
export async function grokCreateImagePost(
  page: Page,
  opts: {
    mediaUrl: string;
    statsigHeaders: GrokHeaders;
  },
): Promise<GrokCreateImagePostResult> {
  const payload = {
    endpoint: ENDPOINT_CREATE_POST,
    statsigHeaders: opts.statsigHeaders,
    body: {
      mediaType: "MEDIA_POST_TYPE_IMAGE",
      mediaUrl: opts.mediaUrl,
    },
  };

  const script = `
    (async ({ endpoint, statsigHeaders, body }) => {
      function pickStringAny(root, keys) {
        const queue = [root];
        const seen = new Set();
        while (queue.length) {
          const cur = queue.shift();
          if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
          seen.add(cur);
          for (const k of keys) {
            const v = cur[k];
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
          for (const v of Object.values(cur)) {
            if (v && typeof v === 'object') queue.push(v);
          }
        }
        return null;
      }
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
          credentials: 'include',
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        const postId = pickStringAny(data, ['id', 'postId', 'parentPostId']);
        const mediaUrl = pickStringAny(data, ['mediaUrl', 'url']);
        let errText = '';
        if (res.status < 200 || res.status >= 300) {
          try { errText = (typeof data === 'string') ? data : JSON.stringify(data); } catch (e) {}
        }
        return { status: res.status, postId, mediaUrl, errText: errText ? errText.slice(0, 500) : '' };
      } catch (e) {
        return { status: 0, postId: null, mediaUrl: null, errText: String(e).slice(0, 500) };
      }
    })
  `;

  if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi tạo image post");
  const res = (await page.evaluate(`(${script})(${JSON.stringify(payload)})`)) as {
    status: number;
    postId: string | null;
    mediaUrl: string | null;
    errText?: string;
  };

  if (res.status < 200 || res.status >= 300 || !res.postId) {
    throw new Error(
      `Grok create image post fail (status=${res.status})` +
        (res.errText ? `: ${res.errText}` : ""),
    );
  }
  return { postId: res.postId, mediaUrl: res.mediaUrl || opts.mediaUrl };
}

export async function grokUploadImage(
  page: Page,
  opts: {
    base64: string;
    fileName: string;
    mimeType: string;
    statsigHeaders: GrokHeaders;
  }
): Promise<GrokUploadResult> {
  const payload = {
    endpoint: ENDPOINT_UPLOAD_FILE,
    statsigHeaders: opts.statsigHeaders,
    body: {
      fileName: opts.fileName,
      fileMimeType: opts.mimeType,
      content: opts.base64,
      fileSource: UPLOAD_FILE_SOURCE,
    },
  };

  const script = `
    (async ({ endpoint, statsigHeaders, body }) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    })
  `;

  if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi upload ảnh");
  const res = (await page.evaluate(`(${script})(${JSON.stringify(payload)})`)) as {
    status: number;
    data: { fileMetadataId?: string; fileUri?: string } | null;
  };

  if (res.status !== 200 || !res.data?.fileMetadataId || !res.data?.fileUri) {
    throw new Error(`Grok upload fail ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  return { fileMetadataId: res.data.fileMetadataId, fileUri: res.data.fileUri };
}

export interface GrokI2VOptions {
  prompt: string;
  fileMetadataId: string;
  fileUri: string;
  /**
   * REQUIRED — postId returned from `grokCreateImagePost`. Do NOT use
   * `fileMetadataId` here (Grok will return 404 invalid-parent-post).
   */
  parentPostId: string;
  /** Optional: media URL normalized by Grok from the create-post step. */
  parentMediaUrl?: string;
  config?: Partial<GrokVideoConfig>;
  statsigHeaders: GrokHeaders;
  timeoutSeconds?: number;
  onProgress?: (p: { progress: number; videoUrl: string | null; parentPostId: string | null }) => void;
}

export async function grokImageToVideo(page: Page, opts: GrokI2VOptions) {
  const cfg: GrokVideoConfig = { ...DEFAULT_VIDEO_CONFIG, ...(opts.config || {}) };
  const timeoutSeconds = opts.timeoutSeconds ?? 15 * 60;

  if (!opts.parentPostId) {
    throw new Error(
      "Grok I2V: thiếu parentPostId (phải gọi grokCreateImagePost trước).",
    );
  }

  const cbName = `__wsu_grok_progress_i2v_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  try {
    await page.exposeFunction(cbName, (p: { progress: number; videoUrl: string | null; parentPostId: string | null }) => {
      opts.onProgress?.(p);
    });
  } catch {
    // already exposed
  }

  const rawUri = (opts.parentMediaUrl || opts.fileUri || "").trim();
  const assetUrl = rawUri.startsWith("http")
    ? rawUri
    : `${GROK_ASSETS_BASE}/${rawUri.replace(/^\//, "")}`;
  const message = `${assetUrl}  ${opts.prompt}`.trim();
  const convoPayload = {
    temporary: true,
    modelName: "grok-3",
    message,
    fileAttachments: [opts.parentPostId],
    toolOverrides: { videoGen: true },
    enableSideBySide: true,
    responseMetadata: {
      experiments: [],
      modelConfigOverride: {
        modelMap: {
          videoGenModelConfig: {
            parentPostId: opts.parentPostId,
            aspectRatio: cfg.aspectRatio,
            videoLength: cfg.videoLength,
            resolutionName: cfg.resolutionName,
            isVideoEdit: false,
          },
        },
      },
    },
  };

  const payload = {
    endpointConvoNew: ENDPOINT_CONVO_NEW,
    endpointUpscale: ENDPOINT_UPSCALE,
    statsigHeaders: opts.statsigHeaders,
    convoPayload,
    timeoutSeconds,
    cbName,
    resolutionName: cfg.resolutionName,
  };

  const script = `
    (async ({ endpointConvoNew, endpointUpscale, statsigHeaders, convoPayload, timeoutSeconds, cbName, resolutionName }) => {
      function parseJsonObjectsFromBuffer(buffer) {
        const out = [];
        let depth = 0;
        let start = -1;
        for (let i = 0; i < buffer.length; i++) {
          const ch = buffer[i];
          if (ch === '{') { if (depth === 0) start = i; depth++; }
          else if (ch === '}') { depth--; if (depth === 0 && start !== -1) { try { out.push(JSON.parse(buffer.slice(start, i+1))); } catch(e) {} start = -1; } }
        }
        return { objects: out, tail: start !== -1 ? buffer.slice(start) : '' };
      }
      function pickLast(objects) {
        let last = null;
        for (const obj of objects) {
          const svr = obj && obj.result && obj.result.response && obj.result.response.streamingVideoGenerationResponse;
          if (svr && typeof svr.progress === 'number') {
            last = { progress: svr.progress, videoUrl: svr.videoUrl || null, parentPostId: svr.parentPostId || null };
          }
        }
        return last;
      }
      function report(p) { try { if (typeof window[cbName] === 'function') window[cbName](p); } catch(e) {} }

      const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
      let res;
      try {
        res = await fetch(endpointConvoNew, {
          method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json', 'x-xai-request-id': requestId }, statsigHeaders || {}),
          credentials: 'include',
          body: JSON.stringify(convoPayload),
          signal: controller.signal,
        });
      } catch(e) { clearTimeout(t); return { convoStatus: 0, convoError: (e && e.message) || String(e), lastEvent: null, mediaUrl: null, hdMediaUrl: null, usedUpscale: false }; }

      // Capture body on non-2xx for debugging
      if (res.status < 200 || res.status >= 300) {
        let errorBody = '';
        try { errorBody = await res.text(); } catch(e) {}
        clearTimeout(t);
        return { convoStatus: res.status, convoError: errorBody.slice(0, 500), lastEvent: null, mediaUrl: null, hdMediaUrl: null, usedUpscale: false };
      }

      let lastEvent = null;
      try {
        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            buffer += decoder.decode(value, { stream: true });
            const parsed = parseJsonObjectsFromBuffer(buffer);
            buffer = parsed.tail;
            const ev = pickLast(parsed.objects);
            if (ev) { lastEvent = ev; report(ev); if (ev.progress >= 100 && ev.videoUrl) break; }
          }
        } else {
          const text = await res.text();
          const parsed = parseJsonObjectsFromBuffer(text);
          lastEvent = pickLast(parsed.objects);
          if (lastEvent) report(lastEvent);
        }
      } catch(e) {}
      clearTimeout(t);

      let mediaUrl = lastEvent ? lastEvent.videoUrl : null;
      let hdMediaUrl = null;
      let usedUpscale = false;
      if (res.status === 200 && lastEvent && lastEvent.progress >= 100 && String(resolutionName).toLowerCase() !== '720p') {
        const parentPostId = lastEvent.parentPostId;
        if (parentPostId) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const ur = await fetch(endpointUpscale, {
                method: 'POST',
                headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
                credentials: 'include',
                body: JSON.stringify({ videoId: parentPostId }),
              });
              const ud = await ur.json().catch(() => null);
              if (ur.status === 200 && ud && ud.hdMediaUrl) { hdMediaUrl = ud.hdMediaUrl; usedUpscale = true; break; }
            } catch(e) {}
            await new Promise(r => setTimeout(r, 2000 * attempt));
          }
          if (hdMediaUrl) mediaUrl = hdMediaUrl;
        }
      }
      return { convoStatus: res.status, convoError: null, lastEvent, mediaUrl, hdMediaUrl, usedUpscale };
    })
  `;

  if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi tạo video");
  const result = (await page.evaluate(`(${script})(${JSON.stringify(payload)})`)) as {
    convoStatus: number;
    convoError?: string | null;
    lastEvent: { progress: number; videoUrl: string | null; parentPostId: string | null } | null;
    mediaUrl: string | null;
    hdMediaUrl: string | null;
    usedUpscale: boolean;
  };

  return result;
}

export async function grokUpscale(
  page: Page,
  opts: { videoId: string; statsigHeaders: GrokHeaders }
): Promise<{ status: number; hdMediaUrl: string | null }> {
  const payload = {
    endpoint: ENDPOINT_UPSCALE,
    statsigHeaders: opts.statsigHeaders,
    body: { videoId: opts.videoId },
  };
  const script = `
    (async ({ endpoint, statsigHeaders, body }) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
            credentials: 'include',
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => null);
          const hd = data && data.hdMediaUrl;
          if (res.status === 200 && hd) return { status: res.status, hdMediaUrl: hd };
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
          else return { status: res.status, hdMediaUrl: hd || null };
        } catch(e) { if (attempt >= 3) return { status: 0, hdMediaUrl: null }; }
      }
      return { status: 0, hdMediaUrl: null };
    })
  `;
  if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi upscale video");
  return (await page.evaluate(`(${script})(${JSON.stringify(payload)})`)) as {
    status: number;
    hdMediaUrl: string | null;
  };
}
