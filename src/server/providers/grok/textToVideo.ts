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
  videoId?: string | null;
  parentPostId: string | null;
  resolutionName?: string | null;
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

        // Carry videoUrl / videoId / parentPostId / resolutionName
        // forward across events so a final {progress:100, videoUrl:null}
        // event doesn't discard a URL we already received. Also accept
        // Grok's alternate URL keys (generatedVideoUrl, mediaUrl).
        // See grok_api_image_to_video.py pickLastProgressEvent for the
        // canonical behaviour.
        function pickLastProgressEvent(objects, prev) {
          let last = prev || null;
          for (const obj of objects) {
            const svr = obj && obj.result && obj.result.response && obj.result.response.streamingVideoGenerationResponse;
            if (!svr || typeof svr !== 'object') continue;
            const hasProgress = (typeof svr.progress === 'number');
            const hasVideoUrl = !!(svr.videoUrl || svr.generatedVideoUrl || svr.generatedVideoUri || svr.mediaUrl);
            const hasVideoId = !!(svr.videoId || svr.videoPostId);
            const hasParent = !!svr.parentPostId;
            const hasResolution = !!svr.resolutionName;
            if (!hasProgress && !hasVideoUrl && !hasVideoId && !hasParent && !hasResolution) continue;
            const prevProgress = (last && typeof last.progress === 'number') ? last.progress : 0;
            const nextProgress = hasProgress ? svr.progress : prevProgress;
            const candidateVideoUrl =
              svr.videoUrl ||
              svr.generatedVideoUrl ||
              svr.generatedVideoUri ||
              svr.mediaUrl ||
              (last ? last.videoUrl : null) ||
              null;
            last = {
              progress: nextProgress,
              videoUrl: candidateVideoUrl,
              videoId: svr.videoId || svr.videoPostId || (last ? last.videoId : null) || null,
              parentPostId: svr.parentPostId || (last ? last.parentPostId : null) || null,
              resolutionName: svr.resolutionName || (last ? last.resolutionName : null) || null,
            };
          }
          return last;
        }

        // Capture non-videoGen signals from the SSE stream. See
        // imageToVideo.ts for the full rationale. Key point: filter
        // out userResponse echo — otherwise "grokSays=" reports the
        // user's own prompt as if it were Grok's rejection reason.
        function collectDiagnostics(objects, prev) {
          const acc = prev || {
            tokens: '',
            errors: [],
            moderation: null,
            finishReason: null,
            sawUserEcho: false,
            sawModelOutput: false,
            sawSvr: false,
          };
          const inputNorm = String(prompt || '').trim();
          for (const obj of objects) {
            const result = obj && obj.result;
            const response = result && result.response;
            const svr = response && response.streamingVideoGenerationResponse;
            const modelResp = response && response.modelResponse;
            const tokenResp = response && response.tokenResponse;
            const userResp = response && response.userResponse;
            if (svr) acc.sawSvr = true;
            if (userResp && (typeof userResp.message === 'string' || userResp.id || userResp.sender)) {
              acc.sawUserEcho = true;
            }
            const rawPieces = [
              tokenResp && typeof tokenResp.token === 'string' ? tokenResp.token : null,
              tokenResp && typeof tokenResp.message === 'string' ? tokenResp.message : null,
              modelResp && typeof modelResp.message === 'string' ? modelResp.message : null,
              modelResp && typeof modelResp.text === 'string' ? modelResp.text : null,
              obj && typeof obj.token === 'string' ? obj.token : null,
            ];
            for (const rawPiece of rawPieces) {
              if (!rawPiece) continue;
              const trimmed = rawPiece.trim();
              if (!trimmed) continue;
              if (inputNorm && (trimmed === inputNorm || inputNorm.indexOf(trimmed) >= 0 || trimmed.indexOf(inputNorm) >= 0)) {
                continue;
              }
              if (acc.tokens.length < 800) {
                acc.tokens += rawPiece;
                acc.sawModelOutput = true;
              }
            }
            const errShapes = [
              obj && obj.error,
              result && result.error,
              response && response.error,
              svr && svr.error,
              modelResp && modelResp.error,
            ];
            for (const e of errShapes) {
              if (!e) continue;
              let m = null;
              if (typeof e === 'string') m = e;
              else if (typeof e === 'object') m = e.message || e.error || e.reason || e.code || null;
              if (m && acc.errors.indexOf(m) < 0) acc.errors.push(String(m).slice(0, 240));
            }
            if (modelResp && modelResp.finishReason && !acc.finishReason) acc.finishReason = String(modelResp.finishReason);
            if (svr && svr.finishReason && !acc.finishReason) acc.finishReason = String(svr.finishReason);
            const modFlags = [
              response && response.moderationResponse,
              response && response.moderationDecision,
              svr && svr.moderationReason,
              svr && svr.rejectionReason,
              svr && svr.failureReason,
              modelResp && modelResp.moderation,
              modelResp && modelResp.softStopReason,
              modelResp && modelResp.isSoftStop ? 'soft-stop' : null,
            ];
            for (const m of modFlags) {
              if (!m) continue;
              const v = (typeof m === 'object') ? (m.reason || m.message || JSON.stringify(m)) : String(m);
              if (v && !acc.moderation) acc.moderation = v.slice(0, 240);
            }
          }
          return acc;
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

          let diagnostics = {
            tokens: '',
            errors: [],
            moderation: null,
            finishReason: null,
            sawUserEcho: false,
            sawModelOutput: false,
            sawSvr: false,
          };
          try {
            if (!res.body) {
              const text = await res.text();
              const parsed = parseJsonObjectsFromBuffer(text);
              diagnostics = collectDiagnostics(parsed.objects, diagnostics);
              lastEvent = pickLastProgressEvent(parsed.objects, null);
              if (lastEvent) reportProgress(lastEvent.progress, lastEvent.videoUrl, lastEvent.parentPostId);
              clearTimeout(t);
              return { status, lastEvent, diagnostics };
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
                diagnostics = collectDiagnostics(parsed.objects, diagnostics);
                const ev = pickLastProgressEvent(parsed.objects, lastEvent);
                if (ev) {
                  lastEvent = ev;
                  reportProgress(lastEvent.progress, lastEvent.videoUrl, lastEvent.parentPostId);
                  // Relaxed break: progress>=95 with a known URL, OR a
                  // bare URL without progress field. Grok sometimes skips
                  // the 100% event entirely once the asset is ready.
                  if ((lastEvent.progress >= 95 && lastEvent.videoUrl) || (lastEvent.videoUrl && typeof lastEvent.progress !== 'number')) break;
                }
              }
            }
            clearTimeout(t);
            return { status, lastEvent, diagnostics };
          } catch (e) {
            // Surface stream/reader errors so "status=200 but no
            // videoUrl" no longer appears to the user as a silent
            // failure. The outer caller decides whether to retry or
            // just tag convoError with this hint.
            clearTimeout(t);
            const errMsg = (e && (e.message || e.name)) ? String(e.message || e.name) : String(e);
            return { status, lastEvent, diagnostics, errorBody: 'stream aborted: ' + errMsg };
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
        // Relaxed completion signal — matches Python has_generation_signal.
        const hasGenerationSignal = !!(
          convo.lastEvent &&
          (
            (typeof convo.lastEvent.progress === 'number' && convo.lastEvent.progress >= 95) ||
            convo.lastEvent.videoUrl ||
            convo.lastEvent.videoId
          )
        );
        if (convo.status === 200 && hasGenerationSignal && !is720p) {
          upscale = await upscaleVideo(created.parentPostId);
          if (upscale && upscale.hdMediaUrl) { finalMediaUrl = upscale.hdMediaUrl; usedUpscale = true; }
        }
        // Build a descriptive convoError when 200 but still no final URL.
        // See imageToVideo.ts for full priority rationale.
        let convoError = convo.errorBody || null;
        if (!finalMediaUrl && convo.status === 200) {
          const diag = convo.diagnostics || {
            tokens: '', errors: [], moderation: null, finishReason: null,
            sawUserEcho: false, sawModelOutput: false, sawSvr: false,
          };
          // Strip chunk-by-chunk echoed prompt from tokens.
          if (diag.tokens && prompt) {
            const inputNorm = String(prompt).trim();
            if (inputNorm && diag.tokens.indexOf(inputNorm) >= 0) {
              diag.tokens = diag.tokens.split(inputNorm).join('<user-prompt-echoed>');
            }
          }
          // Hallucinated success — "I generated a video…" without SVR.
          const tokensLower = (diag.tokens || '').toLowerCase();
          const hallucinatedSuccess = !finalMediaUrl && !diag.sawSvr && (
            tokensLower.indexOf('i generated a video') >= 0 ||
            tokensLower.indexOf('i created a video') >= 0 ||
            tokensLower.indexOf("i've generated") >= 0 ||
            tokensLower.indexOf('i have generated') >= 0 ||
            tokensLower.indexOf("here's a video") >= 0 ||
            tokensLower.indexOf('here is a video') >= 0 ||
            tokensLower.indexOf('video has been generated') >= 0 ||
            tokensLower.indexOf('video is ready') >= 0
          );
          const parts = [];
          if (hallucinatedSuccess) parts.push('hallucinatedSuccess=true');
          if (diag.moderation) parts.push('moderation=' + diag.moderation);
          if (diag.finishReason) parts.push('finishReason=' + diag.finishReason);
          if (diag.errors && diag.errors.length) parts.push('error=' + diag.errors.join(' | '));
          const trimmedTokens = (diag.tokens || '').trim();
          if (trimmedTokens) parts.push('grokSays=' + trimmedTokens.slice(0, 400));
          if (convoError) parts.push(convoError);
          if (diag.sawUserEcho && !diag.sawModelOutput && !diag.sawSvr &&
              !diag.moderation && !diag.finishReason &&
              (!diag.errors || !diag.errors.length)) {
            parts.push('silentRejection=true');
          }
          if (!parts.length) {
            if (convo.lastEvent) {
              parts.push(
                'noMediaUrl progress=' + (convo.lastEvent.progress == null ? '?' : convo.lastEvent.progress) +
                ' videoId=' + (convo.lastEvent.videoId || '∅') +
                ' parentPostId=' + (convo.lastEvent.parentPostId || '∅'),
              );
            } else {
              parts.push('no events received from Grok stream');
            }
          }
          convoError = parts.join(' ; ');
        }
        return {
          createStatus: created.status,
          parentPostId: created.parentPostId,
          convoStatus: convo.status,
          convoError,
          lastEvent: convo.lastEvent || null,
          upscaleStatus: upscale ? upscale.status : 0,
          usedUpscale,
          mediaUrl: finalMediaUrl,
          hdMediaUrl: usedUpscale ? (upscale ? upscale.hdMediaUrl : null) : null,
        };
      })
    `;

    if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi tạo video");
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
