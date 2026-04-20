# MCP Server — Workflow Space Ultra

Tài liệu tham chiếu đầy đủ cho module **Model Context Protocol (MCP)** của Workflow Space Ultra. Bao gồm kiến trúc, cài đặt, cấu hình client, catalog tool/resource, mô hình bảo mật và hướng dẫn xử lý sự cố.

- **Phiên bản module**: `0.1.0`
- **SDK phụ thuộc**: `@modelcontextprotocol/sdk@^1.29.0`
- **Runtime**: Node.js ≥ 18 (ESM, stdio + Streamable HTTP)
- **Cập nhật lần cuối**: 2026-04-21

## Mục lục

1. [Mục đích](#mục-đích)
2. [Kiến trúc](#kiến-trúc)
3. [Cấu trúc module](#cấu-trúc-module)
4. [Cài đặt & build](#cài-đặt--build)
5. [Transport](#transport)
6. [Cấu hình client](#cấu-hình-client)
7. [Tool catalog](#tool-catalog)
8. [Resource catalog](#resource-catalog)
9. [Snapshot bridge](#snapshot-bridge)
10. [Bảo mật](#bảo-mật)
11. [Kiểm thử](#kiểm-thử)
12. [Quy ước & ràng buộc](#quy-ước--ràng-buộc)
13. [Troubleshooting](#troubleshooting)
14. [File reference](#file-reference)
15. [Onboarding checklist](#onboarding-checklist)

---

## Mục đích

MCP (Model Context Protocol) là chuẩn JSON-RPC cho phép một AI client (Cursor, Claude Desktop, Antigravity, ChatGPT, …) gọi **tools** và đọc **resources** do một server cung cấp. Module MCP của Workflow Space Ultra bọc toàn bộ pipeline generation của dự án thành một MCP server, nhờ đó AI assistant có thể:

- Sinh ảnh (VEO Nano Banana, Imagen) và video (VEO 3.1 Ultra, Grok Imagine).
- Theo dõi và huỷ job trong queue.
- Đọc snapshot của workflow (graph nodes + edges) và file asset đã sinh.
- Kiểm tra trạng thái đăng nhập VEO / Grok, mở Chrome đăng nhập lại khi cần.

Mọi lệnh MCP đi qua **cùng executor + queue + lane** với UI canvas — MCP không phải đường chạy song song, chỉ là cổng gọi thêm. Nhờ đó concurrency limit, cancellation, asset layout đều nhất quán giữa UI và MCP.

> **Không thuộc phạm vi**: MCP server không mở rộng khả năng của VEO/Grok vượt mức UI, không bypass login, không tự host cloud. Mọi tool generation vẫn yêu cầu Chrome + login session sống trên cùng máy.

---

## Kiến trúc

```
┌──────────────────────┐   JSON-RPC over stdio / HTTP  ┌──────────────────────┐
│  AI Client           │ ─────────────────────────────>│  MCP Server          │
│  Cursor / Claude /   │                               │  createMcpServer()   │
│  Antigravity /       │                               │  ┌────────────────┐  │
│  ChatGPT / custom    │                               │  │ registerTools  │  │
└──────────────────────┘                               │  └────────────────┘  │
                                                       │  ┌────────────────┐  │
                                                       │  │ registerResrcs │  │
                                                       │  └────────────────┘  │
                                                       └──────────┬───────────┘
                                                                  │
                               ┌──────────────────────────────────┼──────────────────────────┐
                               ▼                                  ▼                          ▼
                      ┌────────────────┐                 ┌─────────────────┐       ┌──────────────────┐
                      │  executor +    │                 │  Workflows/     │       │  data_general/   │
                      │  queue + lanes │                 │  ├─ snapshot.json│      │  ├─ mcp_token.txt │
                      │  (in-memory)   │                 │  └─ assets/**    │      │  └─ *_cache.json  │
                      └────────┬───────┘                 └─────────────────┘       └──────────────────┘
                               │
                               ▼
                      ┌────────────────┐
                      │  Chrome (VEO / │
                      │  Grok) via     │
                      │  Playwright    │
                      └────────────────┘
```

Hai transport cùng dùng một factory `createMcpServer()` (`src/server/mcp/createServer.ts`):

| Transport | Entry point | Khi nào dùng |
|---|---|---|
| **Stdio** | `bin/wsu-mcp.mjs` (import `dist-mcp/createServer.mjs`) | Client spawn subprocess local — Cursor, Claude Desktop, Antigravity |
| **HTTP** (Streamable) | `POST/GET/DELETE /api/mcp` (`src/app/api/mcp/route.ts`) | Client remote/cloud — ChatGPT, Cursor dạng URL, custom host |

---

## Cấu trúc module

```
src/server/mcp/
├── createServer.ts   # McpServer factory — đăng ký tools + resources + capabilities
├── tools.ts          # Đăng ký 12 tool (generation / job / workflow / auth)
├── resources.ts      # Đăng ký 2 resource template (snapshot + asset)
├── schemas.ts        # Zod schemas cho mọi tool input
├── runJob.ts         # Cầu nối executor + queue + lane cho MCP
└── auth.ts           # Bearer token gate cho HTTP transport

src/app/api/
├── mcp/route.ts                               # HTTP endpoint (auth + transport)
└── workflows/[id]/snapshot/route.ts           # Bridge IndexedDB → Workflows/<id>/snapshot.json

bin/wsu-mcp.mjs          # Stdio entry (Windows-safe dynamic import)
scripts/build-mcp.mjs    # esbuild bundler → dist-mcp/createServer.mjs
dist-mcp/                # Artifact build (.gitignore)
```

---

## Cài đặt & build

### Dependencies

Đã declare sẵn trong `package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0"
  },
  "devDependencies": {
    "esbuild": "^0.28.0",
    "tsx": "^4.21.0"
  },
  "scripts": {
    "mcp": "node bin/wsu-mcp.mjs",
    "mcp:build": "node scripts/build-mcp.mjs"
  }
}
```

### Lần đầu setup

```bash
npm install
npm run mcp:build    # sinh dist-mcp/createServer.mjs (+ sourcemap)
```

`scripts/build-mcp.mjs` cấu hình esbuild:

| Setting | Giá trị | Lý do |
|---|---|---|
| `entryPoints` | `src/server/mcp/createServer.ts` | Factory duy nhất |
| `outfile` | `dist-mcp/createServer.mjs` | Stdio entry import file này |
| `platform` | `node` | Không polyfill browser APIs |
| `format` | `esm` | Khớp `"type": "module"` của entry |
| `target` | `node18` | Bao phủ LTS hiện hành |
| `packages` | `external` | Giữ `node_modules` bên ngoài — không nhân đôi Playwright/undici |
| `banner.js` | shim `require` / `__dirname` / `__filename` | Cho dependency CJS-only |

### Khi nào cần rebuild?

Sau khi sửa bất kỳ file nào trong `src/server/mcp/**`, `src/server/executor.ts`, `src/server/queue.ts`, `src/server/lanes.ts`, hoặc lib mà MCP import. Chạy:

```bash
npm run mcp:build
```

HTTP transport **không** cần rebuild — Next.js (`npm run dev` / `npm run start`) tự hot-reload.

---

## Transport

### Stdio

- Entry: `bin/wsu-mcp.mjs`.
- Lazy check: nếu `dist-mcp/createServer.mjs` chưa tồn tại → in hướng dẫn và `exit(1)`.
- Windows-safe: dynamic import dùng `pathToFileURL(bundled).href` để tránh `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
- Stdout là JSON-RPC frame — `console.log` đã được redirect sang stderr để không làm hỏng protocol.
- `SIGINT` / `SIGTERM` → gọi `server.close()` để không rò Chrome / queue state.

### HTTP (Streamable)

- Endpoint: `POST` | `GET` | `DELETE` tại `/api/mcp`.
- Transport: `WebStandardStreamableHTTPServerTransport` — nhận Web-standard `Request` và trả `Response`, khớp trực tiếp Next.js App Router (không cần adapter).
- Stateless: mỗi request spawn `McpServer + transport` mới. State dùng chung (queue, lanes, Chrome sessions) nằm trên `globalThis` nên sống xuyên request.
- Bắt buộc header `Authorization: Bearer <MCP_TOKEN>`. Thiếu/sai → `401` với JSON-RPC error `-32001` và header `WWW-Authenticate: Bearer realm="wsu-mcp"`.

### Smoke test HTTP

```bash
# Lấy token
TOKEN=$(cat data_general/mcp_token.txt)

# Liệt kê tools
curl -s http://localhost:3000/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## Cấu hình client

Thay `D:/tool/master_video/workflow-space-ultra` bằng **đường dẫn tuyệt đối** tới repo. `cwd` là bắt buộc cho stdio — server dùng `process.cwd()` để tìm `data_general/`, `Workflows/`, Chrome user-data dirs.

### Cursor

`~/.cursor/mcp.json` (global) hoặc `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "workflow-space-ultra": {
      "command": "node",
      "args": ["D:/tool/master_video/workflow-space-ultra/bin/wsu-mcp.mjs"],
      "cwd": "D:/tool/master_video/workflow-space-ultra"
    }
  }
}
```

HTTP variant (khi Next.js đang chạy):

```json
{
  "mcpServers": {
    "workflow-space-ultra": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Claude Desktop

File config:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "workflow-space-ultra": {
      "command": "node",
      "args": ["D:/tool/master_video/workflow-space-ultra/bin/wsu-mcp.mjs"],
      "cwd": "D:/tool/master_video/workflow-space-ultra"
    }
  }
}
```

Restart Claude Desktop sau khi chỉnh file.

### Antigravity (Google)

File `mcp_config.json` trong workspace.

**Stdio** (khuyến nghị cho máy cá nhân):

```json
{
  "mcpServers": {
    "workflow-space-ultra": {
      "command": "node",
      "args": ["D:/tool/master_video/workflow-space-ultra/bin/wsu-mcp.mjs"],
      "cwd": "D:/tool/master_video/workflow-space-ultra",
      "env": {}
    }
  }
}
```

**HTTP** (khi Next.js đang chạy `npm run dev`):

```json
{
  "mcpServers": {
    "workflow-space-ultra": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Reload workspace Antigravity sau khi thêm config → bảng MCP tools sẽ hiển thị `workflow-space-ultra` với toàn bộ tool và resource.

### ChatGPT / custom remote

1. Bật ChatGPT Connectors hoặc Custom GPT actions hỗ trợ MCP URL.
2. Expose máy chạy Next.js ra ngoài qua `cloudflared` / `ngrok` / reverse-proxy TLS.
3. Point client tới `https://<host>/api/mcp` kèm header `Authorization: Bearer <token>`.

> Module **không** tự terminate TLS. Luôn dùng proxy TLS trước khi expose public — VEO/Grok session đang bind vào Chrome profile là credential đầy đủ.

---

## Tool catalog

Tổng cộng **12 tool**. Schema đầy đủ tại `src/server/mcp/schemas.ts`.

### Generation (5)

| Tool | Chức năng | Input chính |
|---|---|---|
| `gen_image` | Sinh ảnh VEO (Nano Banana / Imagen). Reference images chỉ Nano Banana nhận. | `prompt`, `modelLabel?`, `aspectRatio?`, `outputCount?`, `seed?`, `referenceImageUrls?`, `workflowId?` |
| `gen_video_t2v` | Text-to-video trên VEO hoặc Grok. | `prompt`, `provider: "veo"\|"grok"`, `aspectRatio?`, `resolution?`, `videoLength?`, `modelLabel?`, `videoModelKey?`, `workflowId?` |
| `gen_video_i2v` | Image-to-video (ảnh = start frame). | Như trên + `startImageUrl` |
| `gen_video_start_end` | VEO frame-first-last (morph start → end). | `prompt`, `startImageUrl`, `endImageUrl`, `aspectRatio?`, `modelLabel?`, `workflowId?` |
| `upscale_grok` | **Chưa wire** — placeholder trả lỗi rõ ràng. Dùng node Upscale trong UI. | — |

Tool generation **blocking**: chờ job hoàn tất rồi trả `/api/workflows/<id>/assets/…`. AI client có thể fetch tiếp qua resource URI `wsu://workflow/<id>/assets/…` mà không cần download riêng.

### Job (3)

| Tool | Chức năng |
|---|---|
| `get_job` | Lấy chi tiết 1 job theo `jobId`. |
| `cancel_job` | Huỷ 1 job. Truyền `jobId: "*"` để huỷ mọi job non-terminal. |
| `list_jobs` | Snapshot queue trong bộ nhớ (mới nhất trước). |

### Workflow (2)

| Tool | Chức năng |
|---|---|
| `list_workflows` | Scan `Workflows/` → id + số asset + `hasSnapshot`. |
| `get_workflow` | Đọc `snapshot.json` (nodes + edges + name) + đếm asset. Chỉ có nếu user đã mở workflow ít nhất 1 lần trong browser. |

### Auth (2)

| Tool | Chức năng |
|---|---|
| `auth_status` | Đọc `veo_tokens_cache.json` + `grok_cache.json`. Trả `{ veo: { ok, projectId, updatedAt }, grok: { ok, profileName, updatedAt } }`. |
| `open_login` | Spawn/reuse Chrome cho VEO hoặc Grok. Trả CDP port. Chỉ chạy được trên máy có browser. |

---

## Resource catalog

2 template đăng ký tại `src/server/mcp/resources.ts`. Host dùng `list()` callback để browse toàn bộ mà không phải đoán path.

| URI | Mô tả | MIME |
|---|---|---|
| `wsu://workflow/{id}/snapshot` | JSON graph (nodes + edges) của workflow. | `application/json` |
| `wsu://workflow/{id}/assets/{+path}` | File media / upload dưới `Workflows/<id>/assets/**`. | Đoán theo đuôi file: `png`, `jpg`/`jpeg`, `webp`, `gif`, `mp4`, `webm`, `mov`, `mp3`, `wav`, `json`, `txt` (fallback `application/octet-stream`). |

Quy tắc content encoding:

- `text/*` và `application/json` → trường `text` (UTF-8).
- Còn lại → trường `blob` (base64).

Mọi path trước khi đọc đi qua `workflowAssetPath()` (`src/server/paths/workflowAssets.ts`) — sandbox chặt: block `..`, symlink escape, absolute path ra ngoài repo.

---

## Snapshot bridge

Workflow graphs sống trong **browser IndexedDB** (xem `src/lib/db.ts`), Node.js không đọc được. Module bắc cầu:

1. **Client side** (`src/state/workflowStore.ts`, trong `_saveCurrentWorkflow`) gọi `pushWorkflowSnapshot(id, name, nodes, edges)`:
   - Debounce theo mỗi lần save IndexedDB.
   - Dedup request đang bay qua map `_snapshotInflight`.
   - `fetch` `PUT /api/workflows/<id>/snapshot` với `keepalive: true`.
2. **Server side** (`src/app/api/workflows/[id]/snapshot/route.ts`):
   - `sanitizeWorkflowId()` chặn path traversal.
   - Validate body là object có `nodes[]` + `edges[]`.
   - Giới hạn **10 MB / snapshot** (constant `MAX_SNAPSHOT_BYTES`).
   - Ghi `Workflows/<id>/snapshot.json` kèm `syncedAt: Date.now()`.
3. **Read path**: MCP client gọi `get_workflow` (tool) hoặc `wsu://workflow/<id>/snapshot` (resource).

**Trade-off**: eventual consistency. Nếu user chưa mở workflow trong browser → snapshot không tồn tại → MCP trả lỗi rõ: *"Open it in the browser UI once so the client writes snapshot.json"*.

---

## Bảo mật

### Bearer token (HTTP)

Logic: `src/server/mcp/auth.ts`.

- **Ưu tiên**: `process.env.MCP_TOKEN` (runtime override, không ghi đĩa).
- **Fallback**: `data_general/mcp_token.txt` — sinh tự động 32 bytes hex (64 ký tự) ở lần đầu start, mode `0600`, persist qua restart.
- **Discovery**: in 1 dòng `[mcp] generated new HTTP bearer token …` vào stderr/console.info sau khi generate để user copy vào client config.
- **So sánh**: `timingSafeEqual` trên buffer, reject silently nếu length mismatch → chống timing attack.

Lấy token đã lưu:

```bash
# macOS / Linux
cat data_general/mcp_token.txt
```

```powershell
# Windows
Get-Content .\data_general\mcp_token.txt
```

### Stdio

Không cần auth. Transport chạy trong subprocess do chính MCP client spawn → không có attack surface qua mạng.

### Path sandbox

`workflowAssetPath()` và `sanitizeWorkflowId()` ngăn:

- `..` escape segment.
- Path tuyệt đối (`/foo`, `C:\foo`) ra ngoài repo.
- ID workflow chứa ký tự nguy hiểm.

Test coverage: `test/unit/mcp.resources.test.ts`.

### Khuyến nghị triển khai

- **Không** expose `/api/mcp` trực tiếp Internet mà không có TLS.
- **Share nhiều user**: mỗi người 1 `MCP_TOKEN` khác nhau (chạy nhiều instance).
- `data_general/mcp_token.txt` đã nằm trong `.gitignore`, **không commit**.

---

## Kiểm thử

3 file test chuyên cho MCP (chạy qua `npm test`):

| File | Phạm vi |
|---|---|
| `test/unit/mcp.schemas.test.ts` | Validate Zod shapes (`ImageInputShape`, `VideoT2VShape`, `VideoI2VShape`, `VideoStartEndShape`) — accept/reject edge cases. |
| `test/unit/mcp.resources.test.ts` | Sandbox `workflowAssetPath()` — chặn `..`, accept path hợp lệ. |
| `test/unit/mcp.auth.test.ts` | Bearer token flow — auto-generate, env override, constant-time compare. |

---

## Quy ước & ràng buộc

| Quy ước | Lý do |
|---|---|
| **Image inputs luôn là URL** (`/api/workflows/…`, `http(s)`, `data:`) | Base64 qua JSON-RPC phình payload; host đã có quyền đọc file. |
| **`workflowId` là optional** ở mọi tool generation | Không truyền → output nằm ở `downloads/` (fallback legacy). |
| **`modelLabel` / `videoModelKey` free-form** | Provider layer là nguồn sự thật; thêm model mới không cần bump schema. |
| **Generation tool blocking** | Chờ job kết thúc rồi trả URL. Muốn background + progress → dùng `list_jobs` / `get_job`. |
| **Lane & concurrency** | MCP tool đi qua `laneKeyOf(kind, genMode)` + `runInLane()` → tuân thủ concurrency limit y hệt UI. |

---

## Troubleshooting

| Triệu chứng | Nguyên nhân | Xử lý |
|---|---|---|
| `dist-mcp/createServer.mjs not found` | Chưa build hoặc build outdated sau `git pull`. | `npm run mcp:build`. |
| Windows: `ERR_UNSUPPORTED_ESM_URL_SCHEME` | Dynamic import absolute path trên Windows. | Đã fix bằng `pathToFileURL(bundled).href` trong `bin/wsu-mcp.mjs`. Kiểm tra file có bản mới. |
| HTTP `401 Unauthorized` | Header `Authorization` thiếu/sai. | Đọc `data_general/mcp_token.txt` hoặc set `MCP_TOKEN` env rồi restart Next.js. |
| `No snapshot for workflow <id>` | User chưa mở workflow đó trong browser. | Mở UI → canvas auto-save → snapshot được push. |
| `auth_status` → `ok: false` | VEO/Grok session hết hạn. | Gọi `open_login` với `target: "veo"` hoặc `"grok"` → đăng nhập xong gọi lại `auth_status`. |
| Client không thấy tool nào | (1) Sai `cwd` → server đọc sai `data_general/`. (2) Chưa build `dist-mcp/`. (3) Client chưa reload config. | Kiểm tra từng nguyên nhân theo thứ tự. |
| `cancel_job` không dừng ngay | Executor check cancel tại safe checkpoint. | MCP trả 200 ngay khi request cancel được ghi nhận; job dừng sau vài giây tại checkpoint gần nhất. |
| Snapshot `413 Payload Too Large` | Workflow > 10 MB. | Tách thành nhiều workflow hoặc tăng `MAX_SNAPSHOT_BYTES` trong `snapshot/route.ts`. |
| Log lẫn vào stdout → JSON-RPC hỏng | Code thêm `console.log` sau khi server connect trong code path MCP. | Redirect sang `console.error`. Trong `bin/wsu-mcp.mjs` đã redirect globally; chỉ cẩn thận với module load sau khi `server.connect(transport)`. |

---

## File reference

| Mục đích | File |
|---|---|
| Factory server | `src/server/mcp/createServer.ts` |
| 12 tool | `src/server/mcp/tools.ts` |
| 2 resource | `src/server/mcp/resources.ts` |
| Zod input shapes | `src/server/mcp/schemas.ts` |
| Wrapper executor cho MCP | `src/server/mcp/runJob.ts` |
| Bearer auth | `src/server/mcp/auth.ts` |
| HTTP endpoint | `src/app/api/mcp/route.ts` |
| Snapshot bridge | `src/app/api/workflows/[id]/snapshot/route.ts` |
| Stdio entry | `bin/wsu-mcp.mjs` |
| Build script | `scripts/build-mcp.mjs` |
| Build output (gitignored) | `dist-mcp/createServer.mjs` |
| Token file (gitignored) | `data_general/mcp_token.txt` |
| Tests | `test/unit/mcp.schemas.test.ts`, `test/unit/mcp.resources.test.ts`, `test/unit/mcp.auth.test.ts` |

---

## Onboarding checklist

Khi triển khai trên máy mới:

1. `git clone` + `npm install`.
2. `npm run mcp:build`.
3. Chọn transport:
   - **Stdio**: thêm block `mcpServers` vào config của Cursor / Claude / Antigravity (xem [Cấu hình client](#cấu-hình-client)).
   - **HTTP**: `npm run dev` → lấy token tại `data_general/mcp_token.txt` hoặc set `MCP_TOKEN` env trước khi start.
4. Mở UI Workflow Space Ultra ít nhất 1 lần; mở các workflow cần expose để snapshot được đẩy lên.
5. Từ AI client: gọi `auth_status` → nếu `ok: false` thì gọi `open_login` → đăng nhập VEO/Grok trong Chrome.
6. Verify flow: `list_jobs`, `list_workflows`, rồi một lần `gen_image` để xác nhận end-to-end.

Hoàn tất — AI client đã kết nối đầy đủ với Workflow Space Ultra qua MCP.
