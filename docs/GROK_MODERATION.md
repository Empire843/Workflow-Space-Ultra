# Grok moderation — `hallucinatedSuccess` và cách hệ thống phát hiện

Tài liệu này ghi lại một failure mode của Grok I2V/T2V mà việc debug trên dữ liệu thực trong quá trình phát triển mới phát hiện ra, cùng với code guard đã thêm vào executor để giải thích lỗi dứt khoát cho người dùng.

## TL;DR

- Grok đôi khi trả `HTTP 200` nhưng **không tạo video** và **không trả flag reject rõ ràng**. Text model chỉ nói kiểu `"I generated a video with the prompt: '…'"` (thực ra không hề gọi tool `videoGen`). Đây là lớp moderation "ngầm" (*silent / hallucinated success*).
- Chúng ta phát hiện chắc chắn bằng 2 tín hiệu: `sawSvr === false` (không có `streamingVideoGenerationResponse` event) **và** text model output khớp template "I generated…".
- Khi phát hiện, executor dừng retry (đây không phải transient) và in lỗi kèm **danh sách trigger cụ thể** tìm thấy trong prompt (bikini, sways hips, close-up, …) để user biết chính xác phải đổi gì.
- Cùng prompt + ảnh có thể **pass Veo** vì Veo/Grok có policy và threshold khác nhau — đây là đặc điểm của moderation pipeline, không phải bug.

## Ngữ cảnh — 2 lớp moderation của Grok

| Lớp | Tín hiệu từ server | Phát hiện trong `convoError` |
|---|---|---|
| **Hard** | `finishReason=SAFETY` / `RECITATION`, `moderationResponse`, `rejectionReason`, text "I can't create that video because…" | `moderation=…`, `finishReason=safety`, `grokSays=…` |
| **Silent** | Không có flag; chỉ `userResponse` echo prompt, rồi đóng stream. Không emit `streamingVideoGenerationResponse` (SVR), không emit tokens. | `silentRejection=true` (sawUserEcho && !sawModelOutput && !sawSvr) |
| **Hallucinated success** | Không có flag, không có SVR, nhưng text model **xuất tokens** khớp template "I generated a video with the prompt: '\<user prompt\>'" — như thể đã làm video xong. | `hallucinatedSuccess=true` (tokens match template && !sawSvr) |

Lớp *Hard* dễ xử — có flag thì báo lại. Lớp *Silent* và *Hallucinated success* nguy hiểm hơn: trước khi có guard, user nhận được `"Grok i2v failed (status=200)"` không kèm lý do, vì code cũ chỉ log `grokSays=…` = chính prompt user gửi (vì tokens chứa prompt echoed). Không rõ là lỗi gì.

## Cách phát hiện trong code

### 1. Stream diagnostics — `collectDiagnostics()`

Trong `page.evaluate` script của `grokImageToVideo` / `grokTextToVideo`, mỗi SSE object từ Grok được soi qua:

```
- response.streamingVideoGenerationResponse → sawSvr=true (tool videoGen được gọi)
- response.userResponse                     → sawUserEcho=true (Grok echo lại prompt, không tính)
- response.tokenResponse.token              → tokens (text model emit)
- response.modelResponse.{message,text}     → tokens
- response.modelResponse.finishReason       → finishReason (SAFETY/RECITATION/…)
- response.moderationResponse               → moderation
- *.error                                   → errors[]
```

Echo filter: piece nào bằng hoặc chứa `userInputMessage` thì bỏ — Grok **luôn** echo lại message qua `userResponse.message` và đôi khi qua `tokenResponse` khi "hallucinate", nếu mine về coi như grokSays thì sẽ false-positive "moderation" với mọi prompt.

### 2. Post-stream detection

Sau khi stream đóng, nếu `!mediaUrl`:

```ts
// src/server/providers/grok/imageToVideo.ts (và textToVideo.ts tương tự)

// Strip substring khớp user input khỏi tokens accumulated
if (diagnostics.tokens && userInputMessage) {
  const inputNorm = String(userInputMessage).trim();
  if (inputNorm && diagnostics.tokens.indexOf(inputNorm) >= 0) {
    diagnostics.tokens = diagnostics.tokens.split(inputNorm).join("<user-prompt-echoed>");
  }
}

// Hallucinated success: tokens khớp template + không có SVR
const tokensLower = (diagnostics.tokens || "").toLowerCase();
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

// Silent rejection: echo + không có model output + không có SVR + không có flag nào khác
const silentRejection =
  diagnostics.sawUserEcho && !diagnostics.sawModelOutput && !diagnostics.sawSvr &&
  !diagnostics.moderation && !diagnostics.finishReason && !diagnostics.errors.length;
```

Các flag này được embed vào `convoError`:

```
hallucinatedSuccess=true ; grokSays=<user-prompt-echoed>… ; …
```

### 3. Retry gate — `src/server/providers/grok/index.ts`

`grokT2V` và `grokI2V` có retry loop 3 lần cho **transient** backend errors (upsampler empty, internal error…). `isGrokTransientBackendError()` **loại trừ** `hallucinatedsuccess=true`, `silentrejection=true`, `moderation=…`, `finishreason=safety|recitation`, `content policy` — tất cả các dấu hiệu moderation. Lý do: retry content policy rejection là vô ích, chỉ đốt thêm request.

### 4. Hint dứt khoát — `interpretGrokRejection()` + `scanGrokRiskyTriggers()`

Đây là phần thêm trong đợt fix này. Trước đó `interpretGrokError` có hint kiểu *"thường do: bikini/swimsuit, sways hips…"* — nghe như đoán. User feedback: "có thể" không rõ, muốn biết chắc chắn.

Giải pháp trong `src/server/executor.ts`:

**`scanGrokRiskyTriggers(prompt)`** — regex scan prompt theo 18 pattern, nhóm:

- Swimwear/underwear: `bikini`, `swimsuit`, `lingerie`, `underwear`, `topless`, `naked/nude`
- Sexualized motion: `sways hips`, `hips sway`, `body/hips/chest moves`, `sensual/seductive`, `suggestive`, `suggestive dancing`
- Framing: `close-up`, `young woman/girl`, `fabric moves/flows`, `wet clothes`
- Violence: `weapon (gun/rifle/pistol/firearm)`, `violence (blood/gore/violent/stab/shoot)`

Tìm thấy gì trả về list canonical labels đó (đã dedupe).

**`interpretGrokRejection(body, prompt)`** — chỉ kích hoạt khi `body` chứa `hallucinatedsuccess=true` / `silentrejection=true` / `moderation=…` / `finishreason=safety|recitation`. Trả hint gồm 3 phần:

1. **Verdict** dứt khoát: `"BỊ REJECT BỞI GROK MODERATION (không phải bug, không phải transient)"`
2. **Evidence**: `"Grok KHÔNG gọi tool videoGen (sawSvr=false), chỉ trả text template 'I generated a video…' — đây là cách Grok từ chối ngầm."`
3. **Triggers cụ thể**: `"Triggers phát hiện trong prompt: [bikini, sways hips, close-up, young woman/girl]"` hoặc, nếu trigger scan empty, `"Không phát hiện trigger rõ ràng trong text prompt → khả năng cao do ẢNH input chứa yếu tố nhạy cảm"`
4. **Fix actionable**: `"bỏ/đổi các cụm trên khỏi prompt VÀ/HOẶC thay ảnh input, hoặc chuyển node sang Veo I2V (policy lỏng hơn)"`

Call site (`runGrokT2V`, `runGrokI2V`) ưu tiên `interpretGrokRejection` trước, fallback về `interpretGrokError` cho các trường hợp không phải reject (transient backend, 400/404/401, stream aborted, …).

## Tại sao Veo pass còn Grok reject cùng 1 prompt + ảnh?

Hai provider do 2 công ty khác nhau (Google vs xAI), dùng moderation stack khác, training data khác, threshold khác. Đây là **by design**, không phải bug bất kỳ bên nào:

| Content | Veo (Google) | Grok (xAI) |
|---|---|---|
| Swimwear/bikini non-explicit, beach, lifestyle | ✅ Thường pass | ❌ Thường reject (lớp Silent / Hallucinated) |
| Celebrity, real person look-alike | ❌ Strict | ⚠️ Medium |
| Disney / copyrighted characters | ❌ Very strict | ✅ Thường pass |
| Action — xe, cháy nổ, thể thao | ✅ Pass | ✅ Pass (thường mượt hơn) |
| Subtle violence, weapon in scene | ⚠️ Medium | ✅ Thường pass |
| Text-in-video, lipsync, dialogue | ✅ Tốt | ⚠️ Medium |

Heuristic workflow:

- **Grok I2V** cho: action, characters/franchise references, abstract motion, ít human close-up gợi cảm.
- **Veo I2V** cho: lifestyle, beach, fashion, dance, female subject close-up, fabric/hair motion, sensual-adjacent không explicit.

## Cách test khi debug failure mới

Khi user báo "Grok i2v failed (status=200)" mà không có hint rõ:

1. Xem đầy đủ `Grok response: …` (đã trong error message). Tìm các flag:
   - `hallucinatedSuccess=true` → silent reject, prompt có trigger.
   - `silentRejection=true` → reject ngay cả khi text không có trigger (→ nghi ảnh).
   - `moderation=` / `finishReason=safety` → hard reject.
   - `error=…upsampler…` → transient backend, retry được.
   - `streamAborted=` → mạng/tab vấn đề, retry.
   - `noMediaUrl progress=100 videoId=∅` → rất lạ, nghi Grok backend bug.
2. Nếu `hallucinatedSuccess=true` + triggers scan ra rỗng → **swap sang Veo** ngay, vì ảnh là thủ phạm.
3. Nếu muốn thêm pattern vào `scanGrokRiskyTriggers()` khi thấy false-negative: thêm regex mới trong `src/server/executor.ts` (hàm cùng tên), mỗi pattern 1 dòng `{ re: /…/gi, label: "…" }`. Tests ở `src/server/__tests__/` (chưa có test riêng cho hàm này — thêm nếu cần).

## Files liên quan

- `src/server/executor.ts`:
  - `scanGrokRiskyTriggers(prompt) → string[]`
  - `interpretGrokRejection(body, prompt) → string | null`
  - `interpretGrokError(status, body) → string` — fallback
  - `runGrokT2V`, `runGrokI2V` — call sites
- `src/server/providers/grok/imageToVideo.ts` — `collectDiagnostics`, `pickLast`, post-stream hallucinated detection
- `src/server/providers/grok/textToVideo.ts` — mirror của I2V
- `src/server/providers/grok/index.ts` — `isGrokTransientBackendError` (whitelist không retry cho reject)

## Lịch sử thay đổi

- **V1** — phát hiện `status=200` không có videoUrl, thêm `pickLast` carry-forward và điều kiện completion `progress>=95 || explicit videoUrl`.
- **V2** — thêm `collectDiagnostics` để mine `error=`, `moderation=`, `finishReason=`, `grokSays=`.
- **V3** — thêm `silentRejection=true` cho pattern echo-only.
- **V4** — thêm `isGrokTransientBackendError` và retry loop cho upsampler/internal errors.
- **V5** — thêm `hallucinatedSuccess=true` cho pattern "I generated a video…" + post-process strip user input echo. Loại hallucinated khỏi retry pool.
- **V6** *(đợt hiện tại)* — thêm `scanGrokRiskyTriggers` + `interpretGrokRejection`: hint đổi từ mơ hồ ("thường do…") sang dứt khoát + evidence + triggers cụ thể liệt kê từ prompt. Call sites ưu tiên hint mới trước fallback về `interpretGrokError`.
