import type { Page } from "playwright";

import type { GrokHeaders } from "../../tokens/grokTokenCollector";
import {
  DEFAULT_VIDEO_CONFIG,
  ENDPOINT_CONVO_NEW,
  ENDPOINT_CREATE_POST,
  ENDPOINT_UPSCALE,
  type GrokVideoConfig,
} from "./constants";

/**
 * Port of grok_api_text_to_video.api_run_single_job_in_page
 *
 * Runs fetch inside the grok.com page context (page.evaluate) so the browser sends cookies itself.
 * We only need to inject the collected x-statsig-id header.
 */

export interface GrokT2VProgress {
  progress: number;
  videoUrl: string | null;
  parentPostId: string | null;
}

export interface GrokT2VResult {
  createStatus: number;
  parentPostId: string | null;
  convoStatus: number;
  /** Body (first 500 chars) when convo status != 2xx — helps debug 400/403/… */
  convoError?: string | null;
  lastEvent: GrokT2VProgress | null;
  upscaleStatus: number;
  usedUpscale: boolean;
  mediaUrl: string | null;
  hdMediaUrl: string | null;
}

export interface GrokT2VOptions {
  prompt: string;
  config?: Partial<GrokVideoConfig>;
  statsigHeaders: GrokHeaders;
  timeoutSeconds?: number;
  onProgress?: (p: GrokT2VProgress) => void;
}

export async function grokTextToVideo(page: Page, opts: GrokT2VOptions): Promise<GrokT2VResult> {
  const cfg: GrokVideoConfig = { ...DEFAULT_VIDEO_CONFIG, ...(opts.config || {}) };
  const timeoutSeconds = opts.timeoutSeconds ?? 15 * 60;

  // Expose progress callback on the page context
  const cbName = `__wsu_grok_progress_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  try {
    await page.exposeFunction(cbName, (p: GrokT2VProgress) => {
      opts.onProgress?.(p);
    });
  } catch {
    // already exposed
  }

  try {
    const payload = {
      prompt: opts.prompt,
      cfg: {
        aspectRatio: cfg.aspectRatio,
        videoLength: cfg.videoLength,
        resolutionName: cfg.resolutionName,
      },
      statsigHeaders: opts.statsigHeaders,
      timeoutSeconds,
      endpointCreatePost: ENDPOINT_CREATE_POST,
      endpointConvoNew: ENDPOINT_CONVO_NEW,
      endpointUpscale: ENDPOINT_UPSCALE,
      cbName,
    };

    const script = `
      (async ({ prompt, cfg, statsigHeaders, timeoutSeconds, endpointCreatePost, endpointConvoNew, endpointUpscale, cbName }) => {
        function parseJsonObjectsFromBuffer(buffer) {
          const out = [];
          let depth = 0;
          let start = -1;
          for (let i = 0; i < buffer.length; i++) {
            const ch = buffer[i];
            if (ch === '{') {
              if (depth === 0) start = i;
              depth++;
            } else if (ch === '}') {
              depth--;
              if (depth === 0 && start !== -1) {
                const slice = buffer.slice(start, i + 1);
                try { out.push(JSON.parse(slice)); } catch (e) {}
                start = -1;
              }
            }
          }
          let tail = '';
          if (start !== -1) tail = buffer.slice(start);
          return { objects: out, tail };
        }

        function pickLastProgressEvent(objects) {
          let last = null;
          for (const obj of objects) {
            const svr = obj && obj.result && obj.result.response && obj.result.response.streamingVideoGenerationResponse;
            if (svr && typeof svr.progress === 'number') {
              last = { progress: svr.progress, videoUrl: svr.videoUrl || null, parentPostId: svr.parentPostId || null };
            }
          }
          return last;
        }

        function reportProgress(pct, videoUrl, parentPostId) {
          try {
            if (typeof window[cbName] === 'function') {
              window[cbName]({ progress: pct, videoUrl: videoUrl || null, parentPostId: parentPostId || null });
            }
          } catch (e) {}
        }

        async function createPost() {
          const res = await fetch(endpointCreatePost, {
            method: 'POST',
            headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
            credentials: 'include',
            body: JSON.stringify({ mediaType: 'MEDIA_POST_TYPE_VIDEO', prompt }),
          });
          const data = await res.json().catch(() => null);
          const id = data && data.post && data.post.id;
          return { status: res.status, parentPostId: id || null };
        }

        async function startConversation(parentPostId) {
          const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
          const convoPayload = {
            temporary: true,
            modelName: 'grok-3',
            message: prompt,
            toolOverrides: { videoGen: true },
            enableSideBySide: true,
            responseMetadata: {
              experiments: [],
              modelConfigOverride: {
                modelMap: { videoGenModelConfig: Object.assign({ parentPostId }, cfg) },
              },
            },
          };

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
          } catch (e) {
            clearTimeout(t);
            return { status: 0, lastEvent: null, errorBody: (e && e.message) || String(e) };
          }

          const status = res.status;
          let lastEvent = null;

          // Non-2xx → capture body as string for caller to debug (e.g. 400 payload validation).
          if (status < 200 || status >= 300) {
            let errorBody = '';
            try { errorBody = await res.text(); } catch (e) {}
            clearTimeout(t);
            return { status, lastEvent: null, errorBody: errorBody.slice(0, 500) };
          }

          try {
            if (!res.body) {
              const text = await res.text();
              const parsed = parseJsonObjectsFromBuffer(text);
              lastEvent = pickLastProgressEvent(parsed.objects);
              if (lastEvent) reportProgress(lastEvent.progress, lastEvent.videoUrl, lastEvent.parentPostId);
              clearTimeout(t);
              return { status, lastEvent };
            }
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
              if (parsed.objects.length) {
                const ev = pickLastProgressEvent(parsed.objects);
                if (ev) {
                  lastEvent = ev;
                  reportProgress(lastEvent.progress, lastEvent.videoUrl, lastEvent.parentPostId);
                  if (lastEvent.progress >= 100 && lastEvent.videoUrl) break;
                }
              }
            }
            clearTimeout(t);
            return { status, lastEvent };
          } catch (e) {
            clearTimeout(t);
            return { status, lastEvent };
          }
        }

        async function upscaleVideo(videoId) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const res = await fetch(endpointUpscale, {
                method: 'POST',
                headers: Object.assign({ 'content-type': 'application/json' }, statsigHeaders || {}),
                credentials: 'include',
                body: JSON.stringify({ videoId }),
              });
              const data = await res.json().catch(() => null);
              const hdMediaUrl = (data && data.hdMediaUrl) ? data.hdMediaUrl : null;
              if (res.status === 200 && hdMediaUrl) return { status: res.status, hdMediaUrl };
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
              return { status: res.status, hdMediaUrl };
            } catch (e) {
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
              return { status: 0, hdMediaUrl: null };
            }
          }
          return { status: 0, hdMediaUrl: null };
        }

        const created = await createPost();
        if (!created.parentPostId) {
          return { createStatus: created.status, parentPostId: null, convoStatus: 0, lastEvent: null, upscaleStatus: 0, usedUpscale: false, mediaUrl: null, hdMediaUrl: null };
        }

        const convo = await startConversation(created.parentPostId);
        let upscale = null;
        let finalMediaUrl = (convo && convo.lastEvent && convo.lastEvent.videoUrl) ? convo.lastEvent.videoUrl : null;
        const is720p = String(cfg.resolutionName || '').toLowerCase() === '720p';
        let usedUpscale = false;
        if (convo.status === 200 && convo.lastEvent && convo.lastEvent.progress >= 100) {
          if (!is720p) {
            upscale = await upscaleVideo(created.parentPostId);
            if (upscale && upscale.hdMediaUrl) { finalMediaUrl = upscale.hdMediaUrl; usedUpscale = true; }
          }
        }
        return {
          createStatus: created.status,
          parentPostId: created.parentPostId,
          convoStatus: convo.status,
          convoError: convo.errorBody || null,
          lastEvent: convo.lastEvent || null,
          upscaleStatus: upscale ? upscale.status : 0,
          usedUpscale,
          mediaUrl: finalMediaUrl,
          hdMediaUrl: usedUpscale ? (upscale ? upscale.hdMediaUrl : null) : null,
        };
      })
    `;

    const evalPromise = page.evaluate(
      `(${script})(${JSON.stringify(payload)})`
    ) as Promise<GrokT2VResult>;

    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(new Error("Grok page.evaluate timeout — Chrome/login có thể bị lỗi")),
        (timeoutSeconds + 60) * 1000,
      );
    });

    let result: GrokT2VResult;
    try {
      result = await Promise.race([evalPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }

    if (!result.parentPostId && result.createStatus !== 200) {
      throw new Error(
        `Grok createPost failed (status=${result.createStatus}). ` +
        `Có thể chưa login hoặc session hết hạn. Hãy mở Chrome Grok và login lại.`
      );
    }

    return result;
  } finally {
    // exposed function cannot be un-exposed easily; leave it
  }
}
