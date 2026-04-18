import { loadConfig, type AccountType } from "../../config";
import { getVeoCollector } from "../../tokens/veoTokenCollector";

import {
  parseGeneratedImages,
  requestCreateImage,
  type CreateImageOptions,
  type GeneratedImage,
} from "./createImage";
import { downloadToDisk } from "./download";
import {
  buildI2VPayload,
  parseUploadMediaId,
  requestCreateI2V,
  requestUploadUserImage,
  type I2VCreateOptions,
  type UploadImageOptions,
} from "./imageToVideo";
import {
  parseOperationsFromCreateResponse,
  requestCheckStatus,
  requestCreateT2V,
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
  onLog?.("Kết nối VEO session…");
  const collector = await getVeoCollector();
  const auth = await collector.collectAuth();
  const config = loadConfig();
  const accountType: AccountType = config.account1.TYPE_ACCOUNT || "ULTRA";
  onLog?.("Session OK. Chuẩn bị reCAPTCHA…");
  return { collector, auth, accountType };
}

/**
 * Run `fn` with a fresh recaptcha token.
 * Retries once if:
 *   - 401 UNAUTHENTICATED → clear cache, reload page, fetch a new access_token
 *   - reCAPTCHA error     → invalidate the recaptcha cache and fetch a new token
 *
 * `fn` receives `(recaptcha, ctx)` so it always uses the latest token (no stale closure).
 */
function isRecaptchaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /PUBLIC_ERROR_UNUSUAL_ACTIVITY/i.test(msg) ||
    /reCAPTCHA evaluation failed/i.test(msg) ||
    /PERMISSION_DENIED/i.test(msg)
  );
}

function isUnauthenticated(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return / 401/.test(msg) || /UNAUTHENTICATED/i.test(msg);
}

async function withRecaptcha<T>(
  fn: (recaptcha: string, ctx: AuthCtx) => Promise<T>,
  mode: "video" | "image" = "video",
  onLog?: LogFn
): Promise<T> {
  let { collector, auth, accountType } = await buildBaseAuth(onLog);
  let attempt = 0;
  while (true) {
    attempt++;
    onLog?.(attempt > 1 ? "Lấy reCAPTCHA token (retry)… (~15-25s)" : "Lấy reCAPTCHA token… (~15-25s)");
    const recaptcha = await collector.getFreshRecaptchaToken(25_000, mode);
    onLog?.("reCAPTCHA OK. Đang gửi request…");
    const ctx: AuthCtx = {
      accessToken: auth.accessToken,
      sessionId: auth.sessionId,
      projectId: auth.projectId,
      cookie: auth.cookie,
      accountType,
    };
    try {
      return await fn(recaptcha, ctx);
    } catch (err) {
      if (attempt < 2 && isUnauthenticated(err)) {
        // access_token expired — clear cache and re-collect from page
        onLog?.("Token hết hạn (401) — đang refresh session… (~15s)");
        collector.invalidateAuth();
        const refreshed = await buildBaseAuth(onLog);
        collector = refreshed.collector;
        // force=true to bypass the just-deleted cache file, reload the page to fetch a fresh token
        auth = await collector.collectAuth({ force: true });
        accountType = refreshed.accountType;
        collector.invalidateRecaptchaCache();
        continue;
      }
      if (attempt < 2 && isRecaptchaError(err)) {
        onLog?.("Lỗi reCAPTCHA — thử lại…");
        collector.invalidateRecaptchaCache();
        await new Promise((r) => setTimeout(r, 1500));
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
  onLog?: LogFn
): Promise<{ raw: GeneratedImage[] }> {
  return withRecaptcha(async (recaptcha, ctx) => {
    const res = await requestCreateImage({
      ...opts,
      recaptchaToken: recaptcha,
      accessToken: ctx.accessToken,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      cookie: ctx.cookie,
      accountType: ctx.accountType,
    });
    if (!res.ok) {
      throw new Error(`VEO createImage ${res.status}: ${res.body.slice(0, 400)}`);
    }
    onLog?.("Đã nhận kết quả ảnh.");
    return { raw: parseGeneratedImages(res.body) };
  }, "image", onLog);
}

export async function veoUploadImage(
  opts: Omit<UploadImageOptions, "accessToken" | "sessionId" | "cookie">,
  onLog?: LogFn
): Promise<string> {
  const { auth } = await buildBaseAuth(onLog);
  onLog?.("Đang upload ảnh tham chiếu lên VEO…");
  const res = await requestUploadUserImage({
    ...opts,
    accessToken: auth.accessToken,
    sessionId: auth.sessionId,
    cookie: auth.cookie,
  });
  if (!res.ok) {
    throw new Error(`VEO uploadImage ${res.status}: ${res.body.slice(0, 400)}`);
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
  onLog?: LogFn
): Promise<{ operations: OperationRef[] }> {
  return withRecaptcha(async (recaptcha, ctx) => {
    const res = await requestCreateT2V({
      ...opts,
      recaptchaToken: recaptcha,
      accessToken: ctx.accessToken,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      cookie: ctx.cookie,
      accountType: ctx.accountType,
    });
    if (!res.ok) {
      throw new Error(`VEO t2v create ${res.status}: ${res.body.slice(0, 400)}`);
    }
    onLog?.("Request tạo video đã gửi. Đang chờ VEO xử lý…");
    return { operations: parseOperationsFromCreateResponse(res.body) };
  }, "video", onLog);
}

export async function veoImageToVideo(
  opts: Omit<
    I2VCreateOptions,
    "recaptchaToken" | "accessToken" | "sessionId" | "projectId" | "cookie" | "accountType"
  >,
  onLog?: LogFn
): Promise<{ operations: OperationRef[] }> {
  return withRecaptcha(async (recaptcha, ctx) => {
    void buildI2VPayload({
      ...opts,
      recaptchaToken: recaptcha,
      accessToken: ctx.accessToken,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      cookie: ctx.cookie,
      accountType: ctx.accountType,
    });
    const res = await requestCreateI2V({
      ...opts,
      recaptchaToken: recaptcha,
      accessToken: ctx.accessToken,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      cookie: ctx.cookie,
      accountType: ctx.accountType,
    });
    if (!res.ok) {
      throw new Error(`VEO i2v create ${res.status}: ${res.body.slice(0, 400)}`);
    }
    onLog?.("Request tạo video (I2V) đã gửi. Đang chờ VEO xử lý…");
    return { operations: parseOperationsFromCreateResponse(res.body) };
  }, "video", onLog);
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
    const { http, entries } = await requestCheckStatus(
      operations,
      auth.accessToken,
      auth.sessionId,
      auth.cookie
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
  opts?: { intervalMs?: number; timeoutMs?: number }
): Promise<StatusEntry[]> {
  const { intervalMs = 4000, timeoutMs = 15 * 60_000 } = opts || {};
  const deadline = Date.now() + timeoutMs;
  let last: StatusEntry[] = [];
  while (Date.now() < deadline) {
    const { entries, finishedAll } = await veoPollStatus(operations);
    last = entries;
    onProgress?.(entries);
    if (finishedAll) return entries;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("VEO poll timeout");
}

export { downloadToDisk as veoDownload };
