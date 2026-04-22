import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { NodeDataBase, NodeKind } from "@/lib/nodes";
import { uid } from "@/lib/utils";
import { openGrokChrome } from "@/server/chrome/grokChromeManager";
import { openVeoChrome } from "@/server/chrome/veoChromeManager";
import { DATA_GENERAL_DIR, GROK_PROFILE_NAME, WORKFLOWS_DIR } from "@/server/config";
import {
  sanitizeWorkflowId,
  workflowAssetsDir,
  workflowDir,
} from "@/server/paths/workflowAssets";
import {
  cancelAllActiveJobs,
  getJob,
  listJobs,
  requestCancel,
} from "@/server/queue";

import {
  BuildWorkflowShape,
  ImageInputShape,
  JobIdShape,
  OpenLoginShape,
  VideoI2VShape,
  VideoStartEndShape,
  VideoT2VShape,
  WorkflowIdShape,
} from "./schemas";
import { runMcpJob } from "./runJob";
import {
  appendMcpNodeToSnapshot,
  buildMcpImageNode,
  buildMcpVideoNode,
  writeFullSnapshot,
  type SnapshotEdge,
} from "./snapshotWriter";

/**
 * Register every MCP tool on `server`. Each tool is a thin wrapper that
 * translates MCP arguments into the shape the existing executor expects,
 * then either runs the job (blocking until done/error) or reads server state
 * (jobs, workflows, auth cache).
 */

// ─── helpers ────────────────────────────────────────────────────────────────

function asImageRef(url: string): NodeDataBase {
  // The executor accepts any of { imageUrl, uploadBase64 + uploadMime,
  // imageMediaId }. An incoming URL — local, remote, or data: — always
  // routes through the `imageUrl` branch (urlToBase64 handles all three).
  return { kind: "content.upload", imageUrl: url };
}

function okText(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

/** Build a synthetic node id for an MCP-originated job so the queue UI can
 *  distinguish it from canvas-run jobs ("mcp_...") without breaking any
 *  existing filtering logic (the prefix itself carries no semantic weight). */
function mcpNodeId(): string {
  return uid("mcp");
}

function pickVideoGenMode(
  provider: "veo" | "grok",
  kind: "t2v" | "i2v",
): "t2v.veo" | "t2v.grok" | "i2v.veo" | "i2v.grok" {
  return `${kind}.${provider}` as const;
}

/**
 * Fire-and-forget wrapper around `appendMcpNodeToSnapshot`. Generation has
 * already succeeded by the time this runs, so any snapshot write failure is
 * logged but never surfaced to the MCP caller — the asset is still on disk
 * and reachable via the returned URLs.
 */
function appendNodeBestEffort(
  workflowId: string | undefined,
  node: Parameters<typeof appendMcpNodeToSnapshot>[1] | null,
  jobId: string,
): void {
  if (!workflowId || !node) return;
  void appendMcpNodeToSnapshot(workflowId, node)
    .then((appended) => {
      if (appended) {
        console.info(`[mcp] appended node ${node.id} to wf=${workflowId}`);
      }
    })
    .catch((err) => {
      console.warn(
        `[mcp] failed to append node for job ${jobId} to wf=${workflowId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
}

/**
 * Auto-create a workflow (dir + empty snapshot) and return its id. Used when
 * MCP gen tools are called without an explicit workflowId — every generation
 * now surfaces on the canvas instead of silently landing in downloads/.
 */
async function autoCreateWorkflow(name: string): Promise<string> {
  const id = uid("wf");
  await writeFullSnapshot(id, name, [], []);
  console.info(`[mcp] auto-created workflow ${id} ("${name}")`);
  return id;
}

// ─── build_workflow tool ────────────────────────────────────────────────────

function registerBuildWorkflowTool(server: McpServer): void {
  server.registerTool(
    "build_workflow",
    {
      title: "Build a complete workflow",
      description:
        "Create a new workflow with connected nodes on the canvas. " +
        "Provide node kinds (content.text, gen.image, gen.video, etc.) and edges to connect them. " +
        "The workflow will appear in the browser UI with all nodes auto-laid out left-to-right. " +
        "Returns the workflowId — use it in subsequent gen_image / gen_video calls to add results to this workflow.",
      inputSchema: BuildWorkflowShape,
    },
    async (args) => {
      try {
        const workflowId = uid("wf");
        const now = Date.now();

        // Convert input nodes → SnapshotNodes
        const snapshotNodes = args.nodes.map((n) => ({
          id: n.id,
          type: "wsNode" as const,
          position: { x: 0, y: 0 }, // auto-layout will reposition
          data: {
            kind: n.kind as NodeKind,
            status: "idle" as const,
            origin: "mcp" as const,
            mcpCreatedAt: now,
            ...(n.data ?? {}),
          } as NodeDataBase,
        }));

        // Convert input edges → SnapshotEdges
        const snapshotEdges: SnapshotEdge[] = (args.edges ?? []).map((e, i) => ({
          id: `edge_${i}_${e.source}_${e.target}`,
          source: e.source,
          target: e.target,
          animated: true,
          style: { stroke: "#ff3c8e" },
        }));

        const ok = await writeFullSnapshot(
          workflowId,
          args.name,
          snapshotNodes,
          snapshotEdges,
        );

        if (!ok) return errorText("Failed to write workflow snapshot.");

        const nodeIds = snapshotNodes.map((n) => n.id);
        console.info(
          `[mcp] built workflow ${workflowId} ("${args.name}") with ${nodeIds.length} node(s), ${snapshotEdges.length} edge(s)`,
        );

        return okText(
          `Created workflow "${args.name}" (${workflowId}) with ${nodeIds.length} node(s) and ${snapshotEdges.length} edge(s).\n` +
            `Open in browser → Dashboard → select "${args.name}" to view the canvas.\n` +
            `Use workflowId="${workflowId}" in gen_image/gen_video calls to add generated outputs to this workflow.`,
          { workflowId, nodeIds, edgeCount: snapshotEdges.length },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );
}

// ─── registrations ─────────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  registerGenerationTools(server);
  registerBuildWorkflowTool(server);
  registerJobTools(server);
  registerWorkflowTools(server);
  registerAuthTools(server);
}

function registerGenerationTools(server: McpServer): void {
  server.registerTool(
    "gen_image",
    {
      title: "Generate image (VEO)",
      description:
        "Generate 1+ images via VEO (Nano Banana / Imagen). Optional reference images are only honored by Nano Banana models; other models silently drop them.",
      inputSchema: ImageInputShape,
    },
    async (args) => {
      try {
        // Auto-create workflow if none specified
        const workflowId = args.workflowId || await autoCreateWorkflow("MCP Image Generation");
        const data: NodeDataBase = {
          kind: "gen.image",
          prompt: args.prompt,
          modelLabel: args.modelLabel,
          aspectRatio: args.aspectRatio,
          outputCount: args.outputCount,
          seed: args.seed,
          genMode: "t2i.veo",
        };
        const inputs = (args.referenceImageUrls ?? []).map(asImageRef);
        const { job, output } = await runMcpJob({
          nodeId: mcpNodeId(),
          kind: "gen.image",
          data,
          inputs,
          workflowId,
        });
        const urls = (output.outputs ?? [])
          .map((o) => o.imageUrl)
          .filter((u): u is string => Boolean(u));
        if (urls.length) {
          appendNodeBestEffort(
            workflowId,
            buildMcpImageNode({
              jobId: job.id,
              prompt: args.prompt,
              outputs: output.outputs ?? [],
              modelLabel: args.modelLabel,
              aspectRatio: args.aspectRatio,
            }),
            job.id,
          );
        }
        return okText(
          urls.length
            ? `Generated ${urls.length} image(s):\n${urls.map((u) => `- ${u}`).join("\n")}`
            : "Job finished but returned no imageUrl.",
          { jobId: job.id, outputs: output.outputs ?? [], imageUrls: urls, workflowId },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "gen_video_t2v",
    {
      title: "Generate video from text",
      description:
        "Text-to-video on VEO or Grok. Blocks until the job finishes, then returns the local file URL.",
      inputSchema: VideoT2VShape,
    },
    async (args) => {
      try {
        const workflowId = args.workflowId || await autoCreateWorkflow("MCP Video Generation");
        const genMode = pickVideoGenMode(args.provider, "t2v");
        const data: NodeDataBase = {
          kind: "gen.video",
          prompt: args.prompt,
          aspectRatio: args.aspectRatio,
          resolution: args.resolution,
          videoLength: args.videoLength,
          outputCount: args.outputCount,
          seed: args.seed,
          modelLabel: args.modelLabel,
          videoModelKey: args.videoModelKey,
          genMode,
        };
        const { job, output } = await runMcpJob({
          nodeId: mcpNodeId(),
          kind: "gen.video",
          data,
          workflowId,
        });
        const urls = (output.outputs ?? [])
          .map((o) => o.videoUrl)
          .filter((u): u is string => Boolean(u));
        if (urls.length) {
          appendNodeBestEffort(
            workflowId,
            buildMcpVideoNode({
              jobId: job.id,
              prompt: args.prompt,
              outputs: output.outputs ?? [],
              kind: "gen.video",
              genMode,
              modelLabel: args.modelLabel,
              videoModelKey: args.videoModelKey,
              aspectRatio: args.aspectRatio,
              resolution: args.resolution,
              videoLength: args.videoLength,
            }),
            job.id,
          );
        }
        return okText(
          urls.length ? `Generated video: ${urls.join(", ")}` : "Job finished but returned no videoUrl.",
          { jobId: job.id, outputs: output.outputs ?? [], videoUrls: urls, workflowId },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "gen_video_i2v",
    {
      title: "Generate video from image",
      description:
        "Image-to-video on VEO (image = start frame) or Grok. Pass the start image as a URL.",
      inputSchema: VideoI2VShape,
    },
    async (args) => {
      try {
        const workflowId = args.workflowId || await autoCreateWorkflow("MCP I2V Generation");
        const genMode = pickVideoGenMode(args.provider, "i2v");
        const data: NodeDataBase = {
          kind: "gen.video",
          prompt: args.prompt,
          aspectRatio: args.aspectRatio,
          resolution: args.resolution,
          videoLength: args.videoLength,
          outputCount: args.outputCount,
          seed: args.seed,
          modelLabel: args.modelLabel,
          videoModelKey: args.videoModelKey,
          genMode,
        };
        const inputs = [asImageRef(args.startImageUrl)];
        const { job, output } = await runMcpJob({
          nodeId: mcpNodeId(),
          kind: "gen.video",
          data,
          inputs,
          workflowId,
        });
        const urls = (output.outputs ?? [])
          .map((o) => o.videoUrl)
          .filter((u): u is string => Boolean(u));
        if (urls.length) {
          appendNodeBestEffort(
            workflowId,
            buildMcpVideoNode({
              jobId: job.id,
              prompt: args.prompt,
              outputs: output.outputs ?? [],
              kind: "gen.video",
              genMode,
              modelLabel: args.modelLabel,
              videoModelKey: args.videoModelKey,
              aspectRatio: args.aspectRatio,
              resolution: args.resolution,
              videoLength: args.videoLength,
            }),
            job.id,
          );
        }
        return okText(
          urls.length ? `Generated video: ${urls.join(", ")}` : "Job finished but returned no videoUrl.",
          { jobId: job.id, outputs: output.outputs ?? [], videoUrls: urls, workflowId },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "gen_video_start_end",
    {
      title: "Generate video with start+end frames (VEO only)",
      description:
        "VEO frame-first-last pipeline — morph from startImageUrl to endImageUrl. Both images required.",
      inputSchema: VideoStartEndShape,
    },
    async (args) => {
      try {
        const data: NodeDataBase = {
          kind: "gen.start-end",
          prompt: args.prompt,
          aspectRatio: args.aspectRatio,
          outputCount: args.outputCount,
          seed: args.seed,
          modelLabel: args.modelLabel,
          videoModelKey: args.videoModelKey,
          genMode: "i2v.veo",
        };
        const inputs = [asImageRef(args.startImageUrl), asImageRef(args.endImageUrl)];
        const { job, output } = await runMcpJob({
          nodeId: mcpNodeId(),
          kind: "gen.start-end",
          data,
          inputs,
          workflowId: args.workflowId,
        });
        const urls = (output.outputs ?? [])
          .map((o) => o.videoUrl)
          .filter((u): u is string => Boolean(u));
        if (urls.length) {
          appendNodeBestEffort(
            args.workflowId,
            buildMcpVideoNode({
              jobId: job.id,
              prompt: args.prompt,
              outputs: output.outputs ?? [],
              kind: "gen.start-end",
              genMode: "i2v.veo",
              modelLabel: args.modelLabel,
              videoModelKey: args.videoModelKey,
              aspectRatio: args.aspectRatio,
            }),
            job.id,
          );
        }
        return okText(
          urls.length ? `Generated video: ${urls.join(", ")}` : "Job finished but returned no videoUrl.",
          { jobId: job.id, outputs: output.outputs ?? [], videoUrls: urls },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.registerTool(
    "upscale_grok",
    {
      title: "Upscale video to HD (Grok)",
      description:
        "Placeholder: Grok HD upscale requires a Grok videoId from a previous Grok generation, which the MCP surface does not yet plumb through. Tracked for a future release.",
      inputSchema: {},
    },
    async () =>
      errorText(
        "upscale_grok is not wired up yet — use the UI's Upscale node for now. " +
          "Feel free to open an issue if you need this via MCP.",
      ),
  );
}

function registerJobTools(server: McpServer): void {
  server.registerTool(
    "get_job",
    {
      title: "Get job status",
      description: "Look up a single queue job by its id.",
      inputSchema: JobIdShape,
    },
    async ({ jobId }) => {
      const rec = getJob(jobId);
      if (!rec) return errorText(`No job with id: ${jobId}`);
      return okText(
        `Job ${rec.id}: status=${rec.status} progress=${rec.progress}%`,
        { job: rec },
      );
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel a running job",
      description:
        "Ask the queue to stop a job at the next safe checkpoint. Pass jobId='*' to cancel every non-terminal job.",
      inputSchema: JobIdShape,
    },
    async ({ jobId }) => {
      if (jobId === "*") {
        const n = cancelAllActiveJobs();
        return okText(`Requested cancel on ${n} active job(s).`, { cancelled: n });
      }
      const rec = getJob(jobId);
      if (!rec) return errorText(`No job with id: ${jobId}`);
      requestCancel(jobId);
      return okText(`Cancel requested for ${jobId}.`, { jobId });
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List queued / running / recent jobs",
      description: "Returns every job the in-memory queue still tracks, newest first.",
      inputSchema: {},
    },
    async () => {
      const jobs = listJobs();
      const summary = jobs
        .map((j) => `- ${j.id} [${j.status}] ${j.kind} (${j.progress}%)`)
        .join("\n");
      return okText(summary || "(no jobs)", { jobs });
    },
  );
}

function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "list_workflows",
    {
      title: "List workflows on disk",
      description:
        "Scans the Workflows/ folder and returns every workflow id with a hasSnapshot flag. Workflow graph itself is only available when the client has synced a snapshot.json (open the workflow in the browser once).",
      inputSchema: {},
    },
    async () => {
      if (!existsSync(WORKFLOWS_DIR)) return okText("No workflows directory yet.", { workflows: [] });
      const entries = readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && sanitizeWorkflowId(d.name) === d.name)
        .map((d) => {
          const id = d.name;
          const snapPath = path.join(WORKFLOWS_DIR, id, "snapshot.json");
          const assetsPath = path.join(WORKFLOWS_DIR, id, "assets");
          let assetsCount = 0;
          try {
            if (existsSync(assetsPath)) {
              const walk = (dir: string) => {
                for (const e of readdirSync(dir, { withFileTypes: true })) {
                  const next = path.join(dir, e.name);
                  if (e.isDirectory()) walk(next);
                  else if (e.isFile()) assetsCount++;
                }
              };
              walk(assetsPath);
            }
          } catch {
            /* ignore */
          }
          let updatedAt: number | null = null;
          try {
            updatedAt = statSync(workflowDir(id)).mtimeMs;
          } catch {
            /* ignore */
          }
          return {
            id,
            hasSnapshot: existsSync(snapPath),
            assetsCount,
            updatedAt,
          };
        });
      const text = entries.length
        ? entries
            .map(
              (e) =>
                `- ${e.id} (${e.assetsCount} asset${e.assetsCount === 1 ? "" : "s"}${
                  e.hasSnapshot ? ", snapshot" : ", no snapshot"
                })`,
            )
            .join("\n")
        : "(no workflows)";
      return okText(text, { workflows: entries });
    },
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow graph",
      description:
        "Returns the latest snapshot.json (nodes + edges + name). Only populated if the user has opened this workflow in the browser at least once.",
      inputSchema: WorkflowIdShape,
    },
    async ({ workflowId }) => {
      const id = sanitizeWorkflowId(workflowId);
      if (!id) return errorText(`Invalid workflow id: ${workflowId}`);
      const snapPath = path.join(workflowDir(id), "snapshot.json");
      if (!existsSync(snapPath)) {
        return errorText(
          `No snapshot.json for workflow ${id}. Open it once in the browser UI so the client syncs it.`,
        );
      }
      const raw = readFileSync(snapPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return errorText(`snapshot.json for ${id} is not valid JSON`);
      }
      const assetsRoot = workflowAssetsDir(id);
      let assetsCount = 0;
      if (existsSync(assetsRoot)) {
        const walk = (dir: string) => {
          for (const e of readdirSync(dir, { withFileTypes: true })) {
            const next = path.join(dir, e.name);
            if (e.isDirectory()) walk(next);
            else if (e.isFile()) assetsCount++;
          }
        };
        walk(assetsRoot);
      }
      return okText(`Workflow ${id} — ${assetsCount} asset file(s) on disk.`, {
        workflowId: id,
        snapshot: parsed,
        assetsCount,
      });
    },
  );
}

function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "auth_status",
    {
      title: "Check VEO + Grok login status",
      description:
        "Reads the cached session tokens on disk. `ok: true` means the provider has a usable session; `ok: false` means the user must run open_login.",
      inputSchema: {},
    },
    async () => {
      const veoFile = path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json");
      const grokFile = path.join(DATA_GENERAL_DIR, "grok_cache.json");

      const veo = safeRead<{
        sessionId?: string;
        projectId?: string;
        accessToken?: string;
        updatedAt?: string;
      }>(veoFile);
      const veoOk = Boolean(veo?.sessionId && veo?.projectId && veo?.accessToken);

      const grok = safeRead<{
        profiles?: Record<
          string,
          { custom_headers?: { "x-statsig-id"?: string }; updated_at?: string }
        >;
      }>(grokFile);
      const grokEntry = grok?.profiles?.[GROK_PROFILE_NAME];
      const grokOk = Boolean(grokEntry?.custom_headers?.["x-statsig-id"]);

      return okText(
        `VEO: ${veoOk ? "OK" : "NOT LOGGED IN"} (projectId=${veo?.projectId ?? "?"})\n` +
          `Grok: ${grokOk ? "OK" : "NOT LOGGED IN"} (profile=${GROK_PROFILE_NAME})`,
        {
          veo: { ok: veoOk, projectId: veo?.projectId ?? null, updatedAt: veo?.updatedAt ?? null },
          grok: {
            ok: grokOk,
            profileName: GROK_PROFILE_NAME,
            updatedAt: grokEntry?.updated_at ?? null,
          },
        },
      );
    },
  );

  server.registerTool(
    "open_login",
    {
      title: "Open Chrome for VEO / Grok login",
      description:
        "Spawns (or reuses) the provider's Chrome instance and navigates to the login URL. Must be run on the same machine as the user's browser.",
      inputSchema: OpenLoginShape,
    },
    async ({ target, profileName }) => {
      try {
        if (target === "veo") {
          const handle = await openVeoChrome();
          return okText(
            `Opened Chrome VEO at CDP port ${handle.port}. Finish the Google login in the new window, then open a Flow project once.`,
            { port: handle.port, userDataDir: handle.userDataDir, target },
          );
        }
        const handle = await openGrokChrome({ profileName: profileName || GROK_PROFILE_NAME });
        return okText(
          `Opened Chrome Grok at CDP port ${handle.port}. Finish the xAI login, then open grok.com/imagine once.`,
          { port: handle.port, userDataDir: handle.userDataDir, target },
        );
      } catch (err) {
        return errorText(err);
      }
    },
  );
}

// ─── helpers (local) ────────────────────────────────────────────────────────

function safeRead<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}
