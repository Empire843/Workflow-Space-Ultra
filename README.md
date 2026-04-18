# Workflow Space Ultra

A node-based AI workflow canvas (Picsart Flow / Freepik AI Suite–style) integrating **VEO 3.1 Ultra** and **Grok Imagine**, running locally and **without any API key**: it reuses your existing browser login sessions on `labs.google/flow` and `grok.com`.

> ⚠️ **Warning**: this tool relies on browser automation + undocumented internal REST endpoints, which is **not** an official integration path from Google or xAI. It is a personal utility. Risks include (1) ToS violation if used commercially, (2) possible account suspension, (3) endpoints / model keys may change at any time. Prefer a secondary account if you have any concern.

## Features

- **Node-based canvas** (pan, zoom, minimap, drag & drop, wiring) — powered by `@xyflow/react`.
- **VEO 3.1 Ultra**: text→image (Nano Banana 2 / Pro / Imagen 4), text→video, image→video, start+end frame interpolation.
- **Grok Imagine**: text→video (480p/720p), image→video (with auto `post/create` pipeline), auto-upscale to HD.
- **Session-based hybrid auth**: Playwright connects via CDP to your running Chrome, captures `access_token` / `recaptcha_token` / `x-statsig-id`, then calls the internal REST APIs directly — faster and more robust than UI automation.
- **Multi-workflow dashboard**: manage many saved workflows, each persisted in IndexedDB (Dexie).
- **Auto-save**: every canvas change is written back to IndexedDB (Zustand middleware).
- **Per-provider job lanes**: configurable concurrency (default 1 for VEO, 2 for Grok) to respect reCAPTCHA locking and account safety.
- **Cascading auto-run**: running a downstream node automatically executes any not-yet-done upstream generation nodes first.
- **Split run buttons**: choose between *run current node only* or *run upstream + this node*.
- **Text chaining**: connect multiple text nodes — the downstream node merges all upstream prompts into one editable + read-only composite prompt (upstream parts are highlighted and locked).
- **Clone on `outputCount > 1`**: producing N outputs spawns N−1 clone nodes so each output lives in its own card.
- **Session-error re-login popup**: when a node fails due to expired VEO/Grok auth, a modal guides the user through Chrome re-login and auto-verifies.
- **Toolbar flyout menus**: the left Image/Video buttons reveal horizontal sub-menus (Upload / Generate·VEO / Generate·Grok / Start+End).
- **Canvas object deletion**: select nodes and/or edges → press <kbd>Delete</kbd> or <kbd>Backspace</kbd> (multi-select supported).
- **Job queue + SSE**: real-time progress streamed back into each node with percentage and status text.
- **Dark, minimal node UI**: edge-to-edge media preview sized to aspect ratio, label below the card, hover mini-toolbar, bottom-center inspector for configuration.

## Stack

| Layer        | Library                                                     |
| ------------ | ----------------------------------------------------------- |
| Framework    | Next.js 15 (App Router), TypeScript, React 19               |
| UI           | Tailwind CSS v4, lucide-react, shadcn-style primitives      |
| Canvas       | `@xyflow/react` (React Flow v12)                            |
| State        | Zustand (+ persist to localStorage)                         |
| Client DB    | Dexie (IndexedDB) for workflows                             |
| Browser auto | Playwright (`connectOverCDP` to the user's Chrome)          |
| HTTP         | `undici` (native fetch) for server-side downloads           |

## Folder layout

```
.
├─ src/
│  ├─ app/                         # Next.js App Router
│  │  ├─ api/                      # REST + SSE endpoints
│  │  │  ├─ auth/{status,logout}/  # auth probe + sign-out
│  │  │  ├─ chrome/open/           # spawn & focus VEO/Grok Chrome
│  │  │  ├─ config/                # GET/POST app config
│  │  │  ├─ download/              # authenticated media proxy
│  │  │  ├─ files/[name]/          # serve downloads/ as /api/files/*
│  │  │  ├─ jobs/                  # POST enqueue, [id] get, [id]/stream SSE
│  │  │  └─ test/{veo,grok}/       # smoke-test auth flow
│  │  ├─ globals.css
│  │  ├─ layout.tsx
│  │  └─ page.tsx
│  ├─ components/
│  │  ├─ canvas/                   # Canvas, WSNode, edges, hover mini-toolbar
│  │  ├─ dashboard/                # multi-workflow selector
│  │  ├─ inspector/                # bottom-center NodeInspector panel
│  │  ├─ login/                    # LoginGate + status badges
│  │  ├─ session/                  # SessionErrorDialog (re-login popup)
│  │  ├─ settings/                 # SettingsDialog
│  │  ├─ sidebar/                  # NodePalette
│  │  ├─ toolbar/                  # LeftToolbar (flyout menus)
│  │  └─ topbar/                   # TopBar (run/save/export)
│  ├─ lib/                         # node catalog, Dexie DB, session-error utils
│  ├─ state/                       # Zustand stores, runWorkflow topo executor
│  └─ server/
│     ├─ config.ts                 # paths, ports, account tier, config JSON
│     ├─ chrome/                   # processManager + VEO/Grok Chrome wrappers
│     ├─ tokens/                   # VEO token collector + Grok statsig discovery
│     ├─ providers/
│     │  ├─ veo/                   # textToVideo, imageToVideo, createImage, download
│     │  └─ grok/                  # textToVideo (SSE), imageToVideo (+ post/create), upload, upscale
│     ├─ queue.ts                  # in-memory job queue + EventEmitter
│     ├─ lanes.ts                  # per-provider concurrency lanes
│     └─ executor.ts               # executes one node per job
├─ chrome_user_data/               # VEO Chrome profile (auto-created, gitignored)
├─ chrome_user_data_grok/          # Grok Chrome profile root (auto-created, gitignored)
├─ downloads/                      # Saved MP4/PNG, served via /api/files/* (gitignored)
├─ data_general/                   # config.json + veo_tokens_cache.json + grok_cache.json (all gitignored)
├─ .docs/                          # requirement.md + plan.md dev notes
├─ .env.example
└─ package.json
```

## Setup

```bash
npm install
```

### Configuration

All configuration keys have sane defaults. You only need to override them when your environment differs. Copy `.env.example` → `.env.local` (optional) and edit, or tweak values later through the in-app **Settings** dialog:

```ini
# Chrome executable path (leave blank for auto-detect on Windows)
CHROME_EXE_PATH=

# VEO
VEO_CDP_PORT=9222
VEO_CHROME_USER_DATA_DIR=./chrome_user_data
VEO_TYPE_ACCOUNT=ULTRA        # NORMAL | PRO | ULTRA

# Grok
GROK_CDP_PORT=9223
GROK_CHROME_USER_DATA_ROOT=./chrome_user_data_grok
GROK_PROFILE_NAME=PROFILE_1

# Window mode: headful | offscreen | headless
CHROME_WINDOW_MODE=headful
```

Runtime folders (`data_general/`, `downloads/`, `Workflows/`, `chrome_user_data*/`) are auto-created on the first run.

## Running

```bash
npm run dev      # http://localhost:3000
```

### First-time login

1. Open `http://localhost:3000`.
2. In the status bar, click the **VEO** badge (it will show **x** if no session exists).
3. The app spawns Chrome with the `chrome_user_data/` profile and navigates to `labs.google/fx/vi/tools/flow`.
4. **Sign in with your VEO Ultra Google account**. Open or create a Flow project — the app captures `sessionId`, `projectId`, `access_token`, and `cookie` automatically and caches them in `data_general/veo_tokens_cache.json`.
5. Do the same for the **Grok** badge → signs into `grok.com` (Super Grok Heavy) → `x-statsig-id` is cached in `data_general/grok_cache.json`.

If a session expires while running, a **session-error popup** will pop up with one-click re-login and auto-verification.

### Using the canvas

1. From the left toolbar, hover the **Image** or **Video** button to see flyout options (Upload / Generate·VEO / Generate·Grok / Start+End). Click one to add a node, or drag from the right-side **Node Palette**.
2. Wire outputs into inputs. Connecting an image node into a text-to-video node automatically switches that node to image-to-video mode.
3. Configure each node through the **bottom-center Inspector** (opens when a node is selected). Fields shown depend on node kind and mode (e.g. Grok reveals `videoLength`, `aspectRatio`, `resolutionName`).
4. Run:
   - **▶ Run current** — execute only the selected node (requires all upstream outputs to already exist, otherwise the provider will error).
   - **⚡ Run with upstream** — cascade: executes pending upstream generation nodes first, then the current node. This button is disabled when all upstream is already `done`.
   - **Run Workflow** (top bar) — topologically sort the full graph and dispatch through the per-provider job lanes.

### Example smoke test

```
[Content · Text]  ──▶  [Text→Image · VEO (Nano Banana 2)]  ──▶  [Image→Video · Grok (720p, 9:16)]  ──▶  HD output
```

## VEO internals (reverse-engineered)

Endpoints ported from the reference tool `RUN_VEO_4.0_V2.2.6` (these are **not** a public Google API):

- `POST /v1/video:batchAsyncGenerateVideoText`
- `POST /v1/video:batchAsyncGenerateVideoStartImage`
- `POST /v1/video:batchAsyncGenerateVideoStartAndEndImage`
- `POST /v1/video:batchCheckAsyncVideoGenerationStatus`
- `POST /v1:uploadUserImage`
- `POST /v1/projects/{projectId}/flowMedia:batchGenerateImages`

Required payload fields:

- `Authorization: Bearer <access_token>` — extracted from `pageProps.session.access_token` on `labs.google/fx/_next/data/...`.
- `clientContext.recaptchaContext.token` — extracted from the `/recaptcha/enterprise/reload?k=<site_key>` response (marker `["rresp", "..."]`).
- `clientContext.sessionId` + `clientContext.projectId`.
- `clientContext.userPaygateTier` — e.g. `PAYGATE_TIER_TWO` for Ultra.
- `videoModelKey` — e.g. `veo_3_1_t2v_fast_ultra`, `veo_3_1_i2v_s_fast_portrait_ultra`, etc.

Model keys are resolved from `TYPE_ACCOUNT` + `aspectRatio` + `fast2Mode` in `src/server/providers/veo/constants.ts`. A **Lower Priority (0 credits)** model variant is included for reCAPTCHA warm-up requests so they don't consume credits.

## Grok internals

Three-step image-to-video pipeline (the missing second step was the cause of the historical `invalid-parent-post` bug):

1. `POST /rest/app-chat/upload-file` → `{ fileMetadataId, fileUri }`
2. `POST /rest/media/post/create` with `{ mediaType: "MEDIA_POST_TYPE_IMAGE", mediaUrl }` → `postId`
3. `POST /rest/app-chat/conversations/new` with `parentPostId: postId` + `fileAttachments: [postId]` → SSE stream of `streamingVideoGenerationResponse.progress` + `videoUrl`

After completion, for 720p targets call `POST /rest/media/video/upscale` with the `videoId` to receive `hdMediaUrl`.

All requests are executed through `page.evaluate()` inside the Grok-origin browser context so cookies and `x-statsig-id` are sent automatically.

## Job queue & concurrency

- `src/server/queue.ts` — in-memory job registry with an `EventEmitter` per job. Clients subscribe via SSE at `GET /api/jobs/:id/stream`.
- `src/server/lanes.ts` — per-provider semaphore. A VEO job never runs in parallel with another VEO job by default (reCAPTCHA is single-use + account safety). Grok defaults to 2 concurrent jobs.
- `src/state/runWorkflow.ts` — topological executor on the client. Handles:
  - Dependency ordering (topo sort).
  - Cascading upstream auto-run with `depRunCache` to avoid duplicate execution when multiple children share an ancestor.
  - Cycle detection via an `ancestors` Set.
  - Clone expansion for `outputCount > 1`.
  - Session-error detection → hands off to the global session-error dialog.

## Development

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
```

See `.docs/requirement.md` and `.docs/plan.md` for the full design log (requirements, phases 1–7i, architectural decisions, and backlog).

## Limitations

- **Fragile**: Google / xAI can change endpoints, response shapes, or reCAPTCHA site keys at any time. When things break, inspect the DevTools Network tab in the real web app and compare payloads.
- **ToS**: Google Flow and Grok do not permit scraping or bot usage. Use with a secondary account at your own risk.
- **Single user, no MFA**: this is a local-only personal tool. No auth, no audit log, no multi-tenant.
- **Upscale node**: the MVP does not yet pipe `grokVideoId` from a Grok-T2V node into a dedicated Upscale node. To implement it, add `grokVideoId` to `NodeDataBase` and thread it through the edge.
- **Extract Frames**: not yet integrated. Planned via `ffmpeg.wasm` client-side.
- **Grok text→image**: intentionally excluded from the current toolbar; a separate plan lives in `.docs/plan-grok-image.md`.

## License

Private / personal use only.
