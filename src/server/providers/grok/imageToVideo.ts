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
    // Pass the raw "message" we sent so the diagnostics collector can
    // filter out echoes — Grok always streams back a userResponse with
    // this exact string and we don't want to misreport it as Grok's
    // explanation for a silent moderation failure.
    userInputMessage: message,
  };

  const script = `
    (async ({ endpointConvoNew, endpointUpscale, statsigHeaders, convoPayload, timeoutSeconds, cbName, resolutionName, userInputMessage }) => {
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
      // Faithful port of grok_api_image_to_video.py's pickLastProgressEvent.
      //
      // Grok streams SVR events like:
      //   { progress: 50, videoUrl: null }
      //   { progress: 75, videoUrl: 'https://assets.grok.com/…' }   ← URL appears here
      //   { progress: 100, videoUrl: null, parentPostId: '…' }       ← trailing 100% may null URL
      //
      // If we just overwrite \`last\` each event we end up with
      // { progress: 100, videoUrl: null } and report "status=200 failed"
      // even though Grok DID generate the video. We must carry
      // videoUrl / videoId / parentPostId / resolutionName forward from
      // earlier events, and also accept the alt keys Grok sometimes
      // uses (generatedVideoUrl / mediaUrl). Only overwrite a carried
      // field when the current event explicitly sets it.
      function pickLast(objects, prev) {
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
      // Collect "soft-fail" diagnostics from the SSE stream.
      //
      // Critical filter: Grok always echoes the user's message back via
      // userResponse.message — we MUST NOT count that as Grok's output.
      // (We saw this bug in the wild: user prompt "A young woman
      // dancing..." being reported as "grokSays=..." and labelled a
      // moderation rejection, when in fact Grok just silently refused
      // without emitting any tokens of its own.)
      //
      // What we look at:
      //   - tokenResponse.token / modelResponse.{message,text}: the MODEL'S
      //     text output (e.g. "I can't create that video because..."). We
      //     skip any piece that's byte-identical to userInputMessage or
      //     that starts with it.
      //   - modelResponse.finishReason: "SAFETY", "RECITATION", "OTHER".
      //   - error / response.error / result.error / svr.error.
      //   - moderationResponse / softStopReason fields.
      //   - sawUserEcho / sawModelOutput / sawSvr: flags that let the
      //     outer handler detect "silent moderation" — Grok received
      //     the prompt, echoed it, then closed the stream without any
      //     model/video output.
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
        const inputNorm = String(userInputMessage || '').trim();
        for (const obj of objects) {
          const result = obj && obj.result;
          const response = result && result.response;
          const svr = response && response.streamingVideoGenerationResponse;
          const modelResp = response && response.modelResponse;
          const tokenResp = response && response.tokenResponse;
          const userResp = response && response.userResponse;
          if (svr) acc.sawSvr = true;
          // userResponse is ALWAYS the echo — record it but don't mine
          // its text (would be false-positive "grokSays").
          if (userResp && (typeof userResp.message === 'string' || userResp.id || userResp.sender)) {
            acc.sawUserEcho = true;
          }
          const rawTokenPieces = [
            tokenResp && typeof tokenResp.token === 'string' ? tokenResp.token : null,
            tokenResp && typeof tokenResp.message === 'string' ? tokenResp.message : null,
            modelResp && typeof modelResp.message === 'string' ? modelResp.message : null,
            modelResp && typeof modelResp.text === 'string' ? modelResp.text : null,
            obj && typeof obj.token === 'string' ? obj.token : null,
          ];
          for (const rawPiece of rawTokenPieces) {
            if (!rawPiece) continue;
            const trimmed = rawPiece.trim();
            if (!trimmed) continue;
            // Skip pieces that are just the user input echoed back.
            if (inputNorm && (trimmed === inputNorm || inputNorm.indexOf(trimmed) >= 0 || trimmed.indexOf(inputNorm) >= 0)) {
              continue;
            }
            if (acc.tokens.length < 800) {
              acc.tokens += rawPiece;
              acc.sawModelOutput = true;
            }
          }
          const errorShapes = [
            obj && obj.error,
            result && result.error,
            response && response.error,
            svr && svr.error,
            modelResp && modelResp.error,
          ];
          for (const errObj of errorShapes) {
            if (!errObj) continue;
            let msg = null;
            if (typeof errObj === 'string') msg = errObj;
            else if (typeof errObj === 'object') msg = errObj.message || errObj.error || errObj.reason || errObj.code || null;
            if (msg && acc.errors.indexOf(msg) < 0) acc.errors.push(String(msg).slice(0, 240));
          }
          if (modelResp && modelResp.finishReason && !acc.finishReason) {
            acc.finishReason = String(modelResp.finishReason);
          }
          if (svr && svr.finishReason && !acc.finishReason) {
            acc.finishReason = String(svr.finishReason);
          }
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
            const val = (typeof m === 'object') ? (m.reason || m.message || JSON.stringify(m)) : String(m);
            if (val && !acc.moderation) acc.moderation = val.slice(0, 240);
          }
        }
        return acc;
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
      let streamError = null;
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
            diagnostics = collectDiagnostics(parsed.objects, diagnostics);
            const ev = pickLast(parsed.objects, lastEvent);
            if (ev) {
              lastEvent = ev;
              report({ progress: ev.progress, videoUrl: ev.videoUrl, parentPostId: ev.parentPostId });
              // Accept progress>=95 (not just 100) with a known videoUrl —
              // Grok occasionally snaps from 95 → "done" without ever
              // emitting the 100% event, and also sometimes emits a late
              // progress=100 with videoUrl nulled. Matches Python.
              if ((ev.progress >= 95 && ev.videoUrl) || (ev.videoUrl && typeof ev.progress !== 'number')) break;
            }
          }
        } else {
          const text = await res.text();
          const parsed = parseJsonObjectsFromBuffer(text);
          diagnostics = collectDiagnostics(parsed.objects, diagnostics);
          lastEvent = pickLast(parsed.objects, null);
          if (lastEvent) report({ progress: lastEvent.progress, videoUrl: lastEvent.videoUrl, parentPostId: lastEvent.parentPostId });
        }
      } catch(e) {
        // Preserve the stream failure so the caller can distinguish
        // "Grok sent 200 + final videoUrl" from "Grok sent 200 then
        // dropped the connection". Previously this catch swallowed
        // everything and the user only saw "Grok i2v failed (status=200)"
        // with no hint that the stream actually aborted.
        streamError = (e && (e.message || e.name)) ? String(e.message || e.name) : String(e);
      }
      clearTimeout(t);

      let mediaUrl = lastEvent ? lastEvent.videoUrl : null;
      let hdMediaUrl = null;
      let usedUpscale = false;
      // Upscale when the stream reports a meaningful completion signal:
      // progress>=95 OR an explicit videoUrl/videoId. Matches Python's
      // has_generation_signal logic. Previously we required strict
      // progress>=100 which missed the 95-then-done edge case and caused
      // valid videos to be dropped as "status=200 failed".
      if (res.status === 200 && lastEvent && String(resolutionName).toLowerCase() !== '720p' &&
          ((lastEvent.progress >= 95) || lastEvent.videoUrl || lastEvent.videoId)) {
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
      // Post-process tokens: strip any substring that matches the user
      // input message. Grok streams tokens chunk-by-chunk; our in-loop
      // filter only compares per-chunk, so an accumulated "I generated
      // a video with the prompt: '<full user prompt>'" slips through.
      if (diagnostics.tokens && userInputMessage) {
        const inputNorm = String(userInputMessage).trim();
        if (inputNorm && diagnostics.tokens.indexOf(inputNorm) >= 0) {
          diagnostics.tokens = diagnostics.tokens.split(inputNorm).join("<user-prompt-echoed>");
        }
      }
      // Detect Grok's "hallucinated success" pattern — the text model
      // politely says "I generated/created a video" without actually
      // invoking videoGen. Near-certain signal of a silent content
      // policy refusal wrapped in diplomatic phrasing. We flag this
      // separately so interpretGrokError can tell the user it's a
      // policy issue (not a retryable backend hiccup).
      const tokensLower = (diagnostics.tokens || '').toLowerCase();
      const hallucinatedSuccess = !mediaUrl && !diagnostics.sawSvr && (
        tokensLower.indexOf("i generated a video") >= 0 ||
        tokensLower.indexOf("i created a video") >= 0 ||
        tokensLower.indexOf("i've generated") >= 0 ||
        tokensLower.indexOf("i have generated") >= 0 ||
        tokensLower.indexOf("here's a video") >= 0 ||
        tokensLower.indexOf("here is a video") >= 0 ||
        tokensLower.indexOf("video has been generated") >= 0 ||
        tokensLower.indexOf("video is ready") >= 0
      );
      // When we got a 200 but no usable media URL, surface every
      // diagnostic signal we collected so the caller can distinguish:
      //   a) content rejected (safety / NSFW / copyright / policy):
      //      moderation or finishReason set, tokens contain an
      //      explanation like "I can't create a video with that content".
      //   b) structured error mid-stream (diagnostics.errors populated).
      //   c) SILENT moderation: userEcho received but NO model output
      //      and NO streamingVideoGenerationResponse — Grok decided not
      //      to invoke videoGen and emitted nothing. Very common failure
      //      mode for mildly-sensitive prompts.
      //   d) stream dropped mid-flight (streamError set).
      //   e) Grok emitted SVR events but never completed a videoUrl.
      //   f) Grok never sent any events at all.
      // Order matters: surface the most specific signal first.
      let convoError = null;
      if (!mediaUrl) {
        const parts = [];
        if (hallucinatedSuccess) parts.push('hallucinatedSuccess=true');
        if (diagnostics.moderation) parts.push('moderation=' + diagnostics.moderation);
        if (diagnostics.finishReason) parts.push('finishReason=' + diagnostics.finishReason);
        if (diagnostics.errors && diagnostics.errors.length) parts.push('error=' + diagnostics.errors.join(' | '));
        const trimmedTokens = (diagnostics.tokens || '').trim();
        if (trimmedTokens) parts.push('grokSays=' + trimmedTokens.slice(0, 400));
        if (streamError) parts.push('streamAborted=' + streamError);
        if (diagnostics.sawUserEcho && !diagnostics.sawModelOutput && !diagnostics.sawSvr &&
            !diagnostics.moderation && !diagnostics.finishReason &&
            (!diagnostics.errors || !diagnostics.errors.length)) {
          parts.push('silentRejection=true');
        }
        if (!parts.length) {
          if (lastEvent) {
            parts.push(
              'noMediaUrl progress=' + (lastEvent.progress == null ? '?' : lastEvent.progress) +
              ' videoId=' + (lastEvent.videoId || '∅') +
              ' parentPostId=' + (lastEvent.parentPostId || '∅'),
            );
          } else {
            parts.push('no events received from Grok stream');
          }
        }
        convoError = parts.join(' ; ');
      }
      return { convoStatus: res.status, convoError, lastEvent, mediaUrl, hdMediaUrl, usedUpscale, diagnostics };
    })
  `;

  if (page.isClosed()) throw new Error("Grok page đã bị đóng trước khi tạo video");
  const result = (await page.evaluate(`(${script})(${JSON.stringify(payload)})`)) as {
    convoStatus: number;
    convoError?: string | null;
    lastEvent: {
      progress: number;
      videoUrl: string | null;
      videoId?: string | null;
      parentPostId: string | null;
      resolutionName?: string | null;
    } | null;
    mediaUrl: string | null;
    hdMediaUrl: string | null;
    usedUpscale: boolean;
    diagnostics?: {
      tokens: string;
      errors: string[];
      moderation: string | null;
      finishReason: string | null;
      sawUserEcho: boolean;
      sawModelOutput: boolean;
      sawSvr: boolean;
    };
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
