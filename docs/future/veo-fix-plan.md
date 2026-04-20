# VEO Anti-Penalize Fix Plan

## Mục tiêu

Khắc phục lỗi Google phạt thời gian chờ (`PUBLIC_ERROR_UNUSUAL_ACTIVITY`) khi sử dụng VEO tạo ảnh/video trong Workflow-Space-Ultra, bằng cách port các cơ chế bảo vệ quan trọng từ source Python gốc (`RUN_VEO_4.0_V2.2.6`).

> **IMPORTANT**: Các fix được sắp xếp theo **mức độ ưu tiên giảm dần**. Fix #1 là quan trọng nhất và nên được thực hiện trước.

---

## Fix #1: Gửi VEO API qua Browser (CRITICAL)

**Vấn đề**: Hiện tại gửi request VEO qua `undici` (Node.js HTTP) — khác TLS fingerprint với Chrome → Google phát hiện mismatch.

**Giải pháp**: Tạo hàm `postViaBrowser()` sử dụng `page.request.post()` từ Playwright, dùng cho VEO generation requests. Giữ `undici` cho polling/download (không nhạy cảm).

### Proposed Changes

#### [MODIFY] `src/server/tokens/veoTokenCollector.ts`

Thêm method `postViaBrowser(url, payload, accessToken)` sử dụng `this.page.request.post()`:

```diff
+  /**
+   * Send a JSON POST through the browser context (same TLS/cookie fingerprint as Chrome).
+   * Used for VEO generation requests to avoid reCAPTCHA fingerprint mismatch.
+   * The main auth page (this.page) is reused — its context carries all cookies.
+   */
+  async postViaBrowser(
+    url: string,
+    payload: unknown,
+    accessToken: string,
+    timeoutMs = 60_000,
+  ): Promise<{ ok: boolean; status: number; body: string }> {
+    if (!this.page) throw new Error("Page not ready for browser request");
+    const resp = await this.page.request.post(url, {
+      data: JSON.stringify(payload),
+      headers: {
+        "Content-Type": "application/json",
+        Authorization: `Bearer ${accessToken}`,
+      },
+      timeout: timeoutMs,
+    });
+    const body = await resp.text();
+    return { ok: resp.ok(), status: resp.status(), body };
+  }
```

#### [MODIFY] `src/server/providers/veo/http.ts`

Thêm hàm `postJsonViaBrowser()` song song với `postJsonWithToken()`:

```diff
+import { getVeoCollector } from "../../tokens/veoTokenCollector";
+
+/**
+ * Send VEO API request through browser Playwright context.
+ * Use for generation requests (createImage, T2V, I2V) to match TLS fingerprint.
+ */
+export async function postJsonViaBrowser(
+  url: string,
+  payload: unknown,
+  accessToken: string,
+  cookie?: string,
+  timeoutMs = 60_000,
+): Promise<HttpResult> {
+  try {
+    const collector = await getVeoCollector();
+    const result = await collector.postViaBrowser(url, payload, accessToken, timeoutMs);
+    return {
+      ok: result.ok,
+      status: result.status,
+      body: result.body,
+      headers: {},
+      url,
+    };
+  } catch (err) {
+    // Fallback to undici if browser request fails
+    console.warn("[VEO] Browser request failed, falling back to undici:", err);
+    return postJsonWithToken(url, payload, accessToken, cookie, timeoutMs);
+  }
+}
```

#### [MODIFY] `src/server/providers/veo/createImage.ts`

```diff
-import { postJsonWithToken, type HttpResult } from "./http";
+import { postJsonViaBrowser, type HttpResult } from "./http";

 export async function requestCreateImage(opts: CreateImageOptions): Promise<HttpResult> {
   const url = URL_GENERATE_IMAGES_TEMPLATE.replace("{projectId}", opts.projectId);
   const payload = buildCreateImagePayload(opts);
-  return postJsonWithToken(url, payload, opts.accessToken, opts.cookie);
+  return postJsonViaBrowser(url, payload, opts.accessToken, opts.cookie);
 }
```

#### [MODIFY] `src/server/providers/veo/textToVideo.ts`

```diff
-import { postJsonWithToken, type HttpResult } from "./http";
+import { postJsonWithToken, postJsonViaBrowser, type HttpResult } from "./http";

 export async function requestCreateT2V(opts: T2VCreateOptions): Promise<HttpResult> {
   const payload = buildT2VPayload(opts);
-  return postJsonWithToken(URL_GENERATE_TEXT_TO_VIDEO, payload, opts.accessToken, opts.cookie);
+  return postJsonViaBrowser(URL_GENERATE_TEXT_TO_VIDEO, payload, opts.accessToken, opts.cookie);
 }
```

> `requestCheckStatus` giữ `postJsonWithToken` (undici) vì polling không nhạy cảm fingerprint.

#### [MODIFY] `src/server/providers/veo/imageToVideo.ts`

```diff
-import { postJsonWithToken, type HttpResult } from "./http";
+import { postJsonWithToken, postJsonViaBrowser, type HttpResult } from "./http";

 export async function requestUploadUserImage(opts: UploadImageOptions): Promise<HttpResult> {
   const payload = buildUploadImagePayload(opts);
-  return postJsonWithToken(URL_UPLOAD_USER_IMAGE, payload, opts.accessToken, opts.cookie);
+  return postJsonViaBrowser(URL_UPLOAD_USER_IMAGE, payload, opts.accessToken, opts.cookie);
 }

 export async function requestCreateI2V(opts: I2VCreateOptions): Promise<HttpResult> {
   const payload = buildI2VPayload(opts);
   const url = opts.endMediaId ? URL_GENERATE_IMAGE_TO_VIDEO_START_END : URL_GENERATE_IMAGE_TO_VIDEO;
-  return postJsonWithToken(url, payload, opts.accessToken, opts.cookie);
+  return postJsonViaBrowser(url, payload, opts.accessToken, opts.cookie);
 }
```

---

## Fix #2: Clear Site Storage Định Kỳ (HIGH)

**Vấn đề**: reCAPTCHA Enterprise tích lũy behavioral fingerprint data trong browser storage → tăng risk score dần.

### Proposed Changes

#### [MODIFY] `src/server/tokens/veoTokenCollector.ts`

Thêm counter + `clearSiteStorage()` method:

```diff
 export class VeoTokenCollector {
+  private _tokenCounter = 0;
+  private _clearDataInterval = 50; // clear every N tokens, matches Python's CLEAR_DATA_TOKEN_IMAGE

+  /**
+   * Port of Python _clear_site_storage: clears localStorage, IndexedDB, cache,
+   * trust tokens, and browser cache for the Flow origin. Then reloads.
+   */
+  private async _clearSiteStorage(page: Page): Promise<void> {
+    const origin = "https://labs.google";
+    try {
+      const cdp = await this.context!.newCDPSession(page);
+      await cdp.send("Storage.clearDataForOrigin", {
+        origin,
+        storageTypes: [
+          "local_storage", "session_storage", "indexeddb",
+          "cache_storage", "service_workers", "websql",
+          "file_systems", "shared_storage",
+        ].join(","),
+      });
+      try { await cdp.send("Storage.clearTrustTokens"); } catch { /* optional */ }
+      await cdp.send("Network.clearBrowserCache");
+      await cdp.detach();
+      console.log("[VEO] Site storage cleared");
+      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
+      await page.waitForTimeout(2000);
+    } catch (err) {
+      console.warn("[VEO] clearSiteStorage failed:", err);
+    }
+  }
```

Gọi trong `_captureRecaptchaOnce()`:

```diff
   private async _captureRecaptchaOnce(...): Promise<string> {
     const page = await this._getPageForMode(mode);
+
+    // Periodic storage clear (Python: CLEAR_DATA_TOKEN_IMAGE)
+    this._tokenCounter++;
+    if (this._clearDataInterval > 0 && this._tokenCounter % this._clearDataInterval === 0) {
+      console.log(`[VEO] Clearing site storage (counter=${this._tokenCounter})`);
+      await this._clearSiteStorage(page);
+      // Re-ensure route blocking after reload
+      this._routeBlockedPages.delete(page);
+      await this.ensureRouteBlocking(page);
+    }
```

---

## Fix #3: Inter-Request Delay cho VEO (HIGH)

**Vấn đề**: TypeScript fire VEO requests liên tục. Python chờ 15-55s.

### Proposed Changes

#### [MODIFY] `src/server/lanes.ts`

Thêm `postRunDelay` per-provider — delay sau mỗi task hoàn thành:

```diff
 interface Lane {
   concurrency: number;
   active: number;
   queue: LaneTask[];
+  /** ms to wait after each task completes before starting the next. */
+  postRunDelayMs: number;
 }

 const DEFAULT_CONCURRENCY: Record<ProviderId, number> = { veo: 1, grok: 1, local: 8 };
+const DEFAULT_POST_RUN_DELAY: Record<ProviderId, number> = { veo: 15_000, grok: 5_000, local: 0 };

 function getLanes(): Record<ProviderId, Lane> {
   if (!g.__wsu_lanes) {
     // ...
     g.__wsu_lanes = {
-      veo: { concurrency: clamp(veoConc, 1, 10), active: 0, queue: [] },
-      grok: { concurrency: clamp(grokConc, 1, 10), active: 0, queue: [] },
-      local: { concurrency: DEFAULT_CONCURRENCY.local, active: 0, queue: [] },
+      veo:   { concurrency: clamp(veoConc, 1, 10), active: 0, queue: [], postRunDelayMs: DEFAULT_POST_RUN_DELAY.veo },
+      grok:  { concurrency: clamp(grokConc, 1, 10), active: 0, queue: [], postRunDelayMs: DEFAULT_POST_RUN_DELAY.grok },
+      local: { concurrency: DEFAULT_CONCURRENCY.local, active: 0, queue: [], postRunDelayMs: DEFAULT_POST_RUN_DELAY.local },
     };
   }
   return g.__wsu_lanes;
 }

 function drain(lane: Lane) {
   while (lane.active < lane.concurrency && lane.queue.length > 0) {
     const task = lane.queue.shift()!;
     lane.active++;
     task
       .run()
       .then((v) => task.resolve(v))
       .catch((e) => task.reject(e))
       .finally(() => {
         lane.active--;
-        drain(lane);
+        if (lane.postRunDelayMs > 0 && lane.queue.length > 0) {
+          setTimeout(() => drain(lane), lane.postRunDelayMs);
+        } else {
+          drain(lane);
+        }
       });
   }
 }
```

#### [MODIFY] `src/server/config.ts`

Thêm config cho delay:

```diff
 export interface AppConfig {
   // ...
   VEO_CONCURRENCY?: number;
   GROK_CONCURRENCY?: number;
+  /** Delay (seconds) between VEO requests. Default: 15. */
+  VEO_REQUEST_DELAY?: number;
+  /** Delay (seconds) between Grok requests. Default: 5. */
+  GROK_REQUEST_DELAY?: number;
 }
```

---

## Fix #4: Idle Page Reload (MEDIUM)

**Vấn đề**: Singleton giữ page mở vĩnh viễn → session/token có thể stale.

### Proposed Changes

#### [MODIFY] `src/server/tokens/veoTokenCollector.ts`

```diff
 export class VeoTokenCollector {
+  private _lastTokenTs = Date.now();
+  private _lastPageReloadTs = Date.now();

   async getFreshRecaptchaToken(...) {
+    // Reload page if idle > 60s (Python: idle_elapsed >= 60)
+    const idleElapsed = (Date.now() - this._lastTokenTs) / 1000;
+    const sinceReload = (Date.now() - this._lastPageReloadTs) / 1000;
+    if (idleElapsed >= 60 && sinceReload >= 30) {
+      console.log(`[VEO] Idle ${idleElapsed.toFixed(0)}s, reloading mode pages`);
+      for (const mode of ["image", "video"] as const) {
+        const pg = this._pages[mode];
+        if (pg) {
+          try {
+            await pg.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
+            this._routeBlockedPages.delete(pg);
+            await this.ensureRouteBlocking(pg);
+          } catch { /* ignore */ }
+        }
+      }
+      this._lastPageReloadTs = Date.now();
+    }
+    this._lastTokenTs = Date.now();
     // ... existing lock + _captureRecaptchaOnce
   }
```

---

## Fix #5: Enhanced Retry + Browser Restart (MEDIUM)

**Vấn đề**: Chỉ retry 1 lần, không restart browser khi liên tục thất bại.

### Proposed Changes

#### [MODIFY] `src/server/providers/veo/index.ts`

```diff
 async function withRecaptcha<T>(
   fn: (recaptcha: string, ctx: AuthCtx) => Promise<T>,
   mode: "video" | "image" = "video",
   onLog?: LogFn
 ): Promise<T> {
   let { collector, auth, accountType } = await buildBaseAuth(onLog);
   let attempt = 0;
+  let consecutiveRecaptchaErrors = 0;
   while (true) {
     attempt++;
     onLog?.(attempt > 1 ? "Lấy reCAPTCHA token (retry)… (~15-25s)" : "Lấy reCAPTCHA token… (~15-25s)");
     const recaptcha = await collector.getFreshRecaptchaToken(25_000, mode);
     onLog?.("reCAPTCHA OK. Đang gửi request…");
     // ...
     try {
       return await fn(recaptcha, ctx);
     } catch (err) {
-      if (attempt < 2 && isUnauthenticated(err)) {
+      if (attempt < 3 && isUnauthenticated(err)) {
         onLog?.("Token hết hạn (401) — đang refresh session… (~15s)");
         collector.invalidateAuth();
         // ...
         continue;
       }
-      if (attempt < 2 && isRecaptchaError(err)) {
+      if (attempt < 3 && isRecaptchaError(err)) {
+        consecutiveRecaptchaErrors++;
         onLog?.("Lỗi reCAPTCHA — thử lại…");
         collector.invalidateRecaptchaCache();
-        await new Promise((r) => setTimeout(r, 1500));
+        // Progressive backoff
+        const delay = consecutiveRecaptchaErrors >= 2 ? 5000 : 1500;
+        await new Promise((r) => setTimeout(r, delay));
         continue;
       }
       throw err;
     }
   }
 }
```

---

## Tổng kết files cần thay đổi

| File | Fix | Thay đổi |
|---|---|---|
| `src/server/tokens/veoTokenCollector.ts` | #1, #2, #4 | `postViaBrowser()`, `_clearSiteStorage()`, idle reload |
| `src/server/providers/veo/http.ts` | #1 | `postJsonViaBrowser()` |
| `src/server/providers/veo/createImage.ts` | #1 | Đổi sang `postJsonViaBrowser` |
| `src/server/providers/veo/textToVideo.ts` | #1 | Đổi sang `postJsonViaBrowser` (create only) |
| `src/server/providers/veo/imageToVideo.ts` | #1 | Đổi sang `postJsonViaBrowser` (upload + create) |
| `src/server/lanes.ts` | #3 | `postRunDelayMs` |
| `src/server/config.ts` | #3 | `VEO_REQUEST_DELAY`, `GROK_REQUEST_DELAY` |
| `src/server/providers/veo/index.ts` | #5 | Tăng max attempt lên 3 + progressive backoff |

---

## Verification Plan

### Automated Tests

1. **Existing tests — đảm bảo không bị break**:
   ```bash
   cd /home/ubuntu/Documents/personal/Workflow-Space-Ultra && npm test
   ```
   Cần pass: `lanes.test.ts`, `prompt.test.ts`, `schemas.test.ts`, tất cả 7 tests.

2. **TypeScript check**:
   ```bash
   cd /home/ubuntu/Documents/personal/Workflow-Space-Ultra && npm run typecheck
   ```

3. **New unit test: lanes delay** — thêm test case vào `test/unit/lanes.test.ts`:
   - Test `postRunDelayMs` thực sự delay trước khi drain task tiếp theo
   - Verify `setLaneConcurrency` vẫn hoạt động đúng với delay

### Manual Verification (yêu cầu tài khoản VEO)

> **WARNING**: Cần có tài khoản VEO đã đăng nhập sẵn trên Chrome instance. Không thể tự động hóa phần này.

1. **Khởi động app**: `npm run dev` → mở `http://localhost:3000`
2. **Đăng nhập VEO**: Click VEO badge → login
3. **Tạo workflow test**: Thêm Text node → Image Generation node → kết nối → Run
4. **Quan sát**:
   - Terminal log nên hiện `[VEO] Browser request` thay vì undici
   - Không bị `PUBLIC_ERROR_UNUSUAL_ACTIVITY`
   - Sau 50 token, log hiện `[VEO] Site storage cleared`
5. **Chạy liên tiếp 3-5 generate** để verify delay hoạt động (15s giữa mỗi request)
