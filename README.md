# Workflow Space Ultra

A node-based AI workflow canvas (Picsart Flow / Freepik AI Suite–style) for **VEO 3.1 Ultra** and **Grok Imagine**, running locally and **without any API key** — it reuses your existing browser login sessions.

> ⚠️ This is a personal utility, not an official integration. It relies on browser automation against undocumented endpoints, which means: (1) it may violate ToS if used commercially, (2) accounts can get suspended, (3) endpoints may change at any time. Use at your own risk, ideally with a secondary account.

## Demo

<!-- Hero screenshot — full canvas with a connected workflow -->
![Workflow Space Ultra — main canvas](./docs/screenshots/hero.png)

<!-- A short GIF/MP4 showing a run end-to-end (text → image → video) -->

<p align="center">
  <img src="./docs/screenshots/run-demo.gif" alt="End-to-end run demo" width="720" />
</p>

<details>
<summary><strong>More screenshots</strong></summary>

| Multi-workflow dashboard                                       | Node inspector                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| ![Dashboard](./docs/screenshots/dashboard.png)                 | ![Inspector](./docs/screenshots/inspector.png)              |

| Cascading run with progress                                    | Session-error re-login popup                                |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| ![Cascading run](./docs/screenshots/cascading-run.png)         | ![Re-login dialog](./docs/screenshots/relogin-dialog.png)   |

</details>

## What it does

- Compose AI image/video pipelines visually on an infinite canvas: drop nodes, wire them up, hit run.
- Generate with **VEO 3.1 Ultra** (text→image, video, start+end frame — text or image input is auto-detected from the upstream graph).
- Generate with **Grok Imagine** (video with auto-upscale to HD — image input is auto-detected from the upstream graph).
- Manage many separate workflows from a dashboard, all auto-saved locally. Generated media and uploads live under `Workflows/<id>/assets/` so previews keep working even after you switch Google / xAI accounts.

## Highlights

- One-click login flow — sign in once through the in-app Chrome popup, sessions are reused automatically.
- Cascading run — running a downstream node auto-executes any pending upstream nodes first.
- Split run buttons — choose between "run only this node" or "run upstream + this node".
- Text chaining — connect multiple text nodes; downstream nodes merge them into one composite prompt.
- Real-time progress streamed onto each node, with per-provider job queues to respect rate limits.
- Auto re-login popup when a session expires — guides you through the recovery flow.
- Full undo/redo history — `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`); drag-as-one-step; safe across progress ticks.
- Quick-add menu — right-click an empty spot on the canvas to spawn a searchable node picker at the cursor (↑/↓/Enter/Esc).
- Dark, minimal Picsart-style UI with edge-to-edge media previews.

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
```

Handy scripts:

```bash
npm test           # run the Vitest unit suite (lanes, prompt chain, zod, runWorkflow topo, ...)
npm run typecheck  # strict TypeScript check
npm run screenshots # regenerate demo screenshots in docs/screenshots/
```

On first run:

1. Open `http://localhost:3000`.
2. Click the **VEO** badge in the status bar — Chrome opens at `labs.google/flow`. Sign in with your VEO Ultra account.
3. Click the **Grok** badge — Chrome opens at `grok.com`. Sign in with your Grok account.

That's it. Sessions are cached locally; you only need to re-login when they expire (the app prompts you).

## Configuration (optional)

Defaults work out of the box. To override, copy `.env.example` → `.env.local` or use the in-app **Settings** dialog.

### Parallel speed: VEO image batcher (R2)

When the workflow has several `gen.image` nodes firing at once, setting
`VEO_IMAGE_BATCH=1` merges them into a single `batchGenerateImages` API call
using **one reCAPTCHA token** instead of N. Expected win scales with parallel
image nodes (1 reCAPTCHA ≈ 8–25s, so 4 merged → save 3 × reCAPTCHA).

```powershell
$env:VEO_IMAGE_BATCH="1"
$env:VEO_IMAGE_BATCH_MAX="4"      # max prompts per batch (default 4, cap 8)
$env:VEO_IMAGE_BATCH_WINDOW_MS="300"  # coalesce window (default 300ms)
npm run dev
```

Guarantees: same result as the non-batched path. Different `modelLabel`s are
never merged (API rejects mixed-model requests). On any demux/API failure,
the batcher transparently falls back to per-caller individual calls — zero
data loss, only no speedup for that round. Measure via `npm run bench`:
look for a new `veo.batch.createImage` span and a drop in `veo.recaptcha.image`
count relative to `executor.gen.image`.

### Workflow assets on disk

Every generated image / video and every file the user drags into an Upload
node is copied to `Workflows/<workflowId>/assets/`:

```
Workflows/
  wf_<ts>_<rand>/
    assets/
      outputs/   ← generated VEO/Grok results (≥ 2K images, ≥ 720p video)
      uploads/   ← files uploaded via Upload nodes
```

Preview URLs on the canvas point at `/api/workflows/<id>/assets/<path>` so
they stay valid after an account switch or restart, and the whole workflow
can be archived by zipping its folder. Runs initiated outside of any open
workflow still work — they fall back to the flat `downloads/` directory as
before.

### Grok content moderation — `hallucinatedSuccess` failure mode

Grok I2V/T2V đôi khi trả `HTTP 200` không kèm video và **không có flag reject rõ ràng** (text model nói "I generated a video…" nhưng không thực sự gọi `videoGen`). Executor phát hiện pattern này qua `sawSvr=false` + template match, dừng retry, và in hint kèm **danh sách trigger cụ thể tìm thấy trong prompt**. Chi tiết + recipe debug + khi nào nên swap sang Veo: [`docs/GROK_MODERATION.md`](docs/GROK_MODERATION.md).

### Debugging undocumented VEO endpoints

If VEO/Flow changes its payload schema and calls start returning `400 Unknown name "…" at "…"`, enable **capture mode** to record the real payload that labs.google's UI sends and compare it against what the tool sends:

```powershell
$env:VEO_CAPTURE_PAYLOADS="1"; npm run dev
```

Then perform the action in the labs.google tab that the tool keeps open (upload a reference image, hit Generate, …). Every intercepted `batchGenerateImages` / `batchAsync*` request is logged as a `[VEO CAPTURE]` block in the terminal — URL, full request body, no truncation. The requests are still short-circuited with `403` so nothing actually fires against your quota. Unset the env var to return to normal run mode.

## MCP server (Cursor / Claude Desktop / ChatGPT / Antigravity integration)

> **Full reference**: see [`docs/MCP.md`](docs/MCP.md) for the complete
> architecture, tool catalog, resource schema, security model, Antigravity
> setup, and troubleshooting guide. The section below is the quickstart only.

Workflow Space Ultra ships an optional **MCP (Model Context Protocol)** surface
so any MCP-aware AI host can trigger VEO / Grok generation, inspect the job
queue, list/read workflow assets, and check login status — all through the
same executor, queue, and concurrency lanes the canvas UI uses.

Two transports are supported; pick one based on how your host connects:

### Option A — stdio (recommended for local Cursor / Claude Desktop)

1. Build the bundle once (and re-run whenever `src/server/mcp/**` changes):

   ```powershell
   npm run mcp:build
   ```

2. Point your MCP client at `bin/wsu-mcp.mjs`. **`cwd` matters** — the server
   resolves `data_general/`, `Workflows/`, and the Chrome user-data dirs
   relative to it.

   **Cursor** (`.cursor/mcp.json` in any workspace or `%USERPROFILE%\.cursor\mcp.json` globally):

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

   **Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json`): same
   shape as above, nested under the top-level `mcpServers` object.

3. Restart the host. The stdio MCP server spawns on first tool invocation;
   no need to have `npm run dev` running.

### Option B — HTTP (remote clients, ChatGPT, shared team server)

1. Start Next.js as usual: `npm run dev`.
2. Grab the bearer token. On first start, a new random token is written to
   `data_general/mcp_token.txt`; the terminal prints its location. To use a
   fixed token instead, set `MCP_TOKEN=...` in the environment before
   `npm run dev`.
3. Configure the client to hit `POST http://localhost:3000/api/mcp` with the
   `Authorization: Bearer <token>` header. Example Cursor config:

   ```json
   {
     "mcpServers": {
       "workflow-space-ultra": {
         "url": "http://localhost:3000/api/mcp",
         "headers": { "Authorization": "Bearer <paste-token-here>" }
       }
     }
   }
   ```

Never expose the HTTP endpoint to the public internet without a tunnel (SSH,
Cloudflare Tunnel, Tailscale …) — the VEO / Grok sessions bound to your
Chrome profile are full-strength credentials.

### What's exposed

**Tools**

| Name                   | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `gen_image`            | VEO Nano Banana / Imagen text-to-image (+ optional reference images)      |
| `gen_video_t2v`        | Text-to-video on VEO or Grok                                              |
| `gen_video_i2v`        | Image-to-video (image = start frame) on VEO or Grok                       |
| `gen_video_start_end`  | VEO frame-first-last: morph from start image to end image                 |
| `upscale_grok`         | Placeholder — not wired up yet, use the UI's Upscale node                 |
| `get_job`              | Poll a single queue job by id                                             |
| `cancel_job`           | Cancel a running job (pass `"*"` to cancel every non-terminal job)        |
| `list_jobs`            | Snapshot of the in-memory queue                                           |
| `list_workflows`       | Scan `Workflows/` on disk; returns id + asset count + `hasSnapshot` flag  |
| `get_workflow`         | Returns the latest `snapshot.json` (nodes + edges + name)                 |
| `auth_status`          | Read the cached VEO + Grok session tokens                                 |
| `open_login`           | Open Chrome and navigate to the VEO / Grok login URL                      |

**Resources**

- `wsu://workflow/<id>/snapshot` — JSON graph (nodes + edges), synced from the
  browser. Only populated after the user opens the workflow once.
- `wsu://workflow/<id>/assets/<path>` — binary / text asset living under
  `Workflows/<id>/assets`. Path traversal is rejected.

Generation tools **block** until the underlying job finishes, then return the
local file URL. The MCP host can immediately turn around and read that URL via
the `wsu://…/assets/…` resource — no separate download step needed.

### Constraints to know

- VEO / Grok rely on a **logged-in Chrome on the same machine**. MCP clients
  running on another machine must tunnel back; there is no cloud path.
- Workflow graphs live in the browser's IndexedDB. The client mirrors them to
  `Workflows/<id>/snapshot.json` on every save, but until the user opens a
  workflow once in the UI, `get_workflow` returns "no snapshot".
- The MCP server reuses the canvas's queue + lanes — firing a generation tool
  while the UI is busy will queue up behind UI jobs (and vice versa).

## License

Private / personal use only.
