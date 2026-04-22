import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

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
  type JobRecord,
} from "@/server/queue";
import {
  appendMcpNodeToSnapshot,
  buildMcpImageNode,
  buildMcpVideoNode,
  writeFullSnapshot,
  type SnapshotEdge,
} from "@/server/mcp/snapshotWriter";
import { runMcpJob } from "@/server/mcp/runJob";
import type {
  BuildWorkflowInput,
  ImageInput,
  VideoI2VInput,
  VideoStartEndInput,
  VideoT2VInput,
} from "@/server/mcp/schemas";

/**
 * Plain-async REST handlers that mirror the behaviour of the MCP tools but
 * return JSON-friendly objects instead of MCP `content[]` wrappers. Both the
 * HTTP `/api/actions/*` routes (OAuth-gated, for ChatGPT GPT Actions) and
 * potentially other transports can call into this layer.
 *
 * The underlying plumbing — `runMcpJob`, the queue, `writeFullSnapshot`,
 * `appendMcpNodeToSnapshot` — is shared with the MCP server, so behaviour
 * stays consistent no matter which transport the caller picks.
 */

// ─── helpers ────────────────────────────────────────────────────────────────

function asImageRef(url: string): NodeDataBase {
  return { kind: "content.upload", imageUrl: url };
}

function actionNodeId(): string {
  return uid("act");
}

function pickVideoGenMode(
  provider: "veo" | "grok",
  kind: "t2v" | "i2v",
): "t2v.veo" | "t2v.grok" | "i2v.veo" | "i2v.grok" {
  return `${kind}.${provider}` as const;
}

function appendNodeBestEffort(
  workflowId: string | undefined,
  node: Parameters<typeof appendMcpNodeToSnapshot>[1] | null,
  jobId: string,
): void {
  if (!workflowId || !node) return;
  void appendMcpNodeToSnapshot(workflowId, node).catch((err) => {
    console.warn(
      `[actions] failed to append node for job ${jobId} to wf=${workflowId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
}

async function autoCreateWorkflow(name: string): Promise<string> {
  const id = uid("wf");
  await writeFullSnapshot(id, name, [], []);
  return id;
}

function safeRead<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ─── generation ─────────────────────────────────────────────────────────────

export interface ImageResult {
  jobId: string;
  workflowId: string;
  imageUrls: string[];
  outputs: NonNullable<NodeDataBase["outputs"]>;
}

export async function runGenImage(args: ImageInput): Promise<ImageResult> {
  const workflowId = args.workflowId || (await autoCreateWorkflow("ChatGPT Image Generation"));
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
    nodeId: actionNodeId(),
    kind: "gen.image",
    data,
    inputs,
    workflowId,
  });
  const outputs = output.outputs ?? [];
  const imageUrls = outputs
    .map((o) => o.imageUrl)
    .filter((u): u is string => Boolean(u));
  if (imageUrls.length) {
    appendNodeBestEffort(
      workflowId,
      buildMcpImageNode({
        jobId: job.id,
        prompt: args.prompt,
        outputs,
        modelLabel: args.modelLabel,
        aspectRatio: args.aspectRatio,
      }),
      job.id,
    );
  }
  return { jobId: job.id, workflowId, imageUrls, outputs };
}

export interface VideoResult {
  jobId: string;
  workflowId: string;
  videoUrls: string[];
  outputs: NonNullable<NodeDataBase["outputs"]>;
}

export async function runGenVideoT2V(args: VideoT2VInput): Promise<VideoResult> {
  const workflowId = args.workflowId || (await autoCreateWorkflow("ChatGPT T2V Generation"));
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
    nodeId: actionNodeId(),
    kind: "gen.video",
    data,
    workflowId,
  });
  const outputs = output.outputs ?? [];
  const videoUrls = outputs
    .map((o) => o.videoUrl)
    .filter((u): u is string => Boolean(u));
  if (videoUrls.length) {
    appendNodeBestEffort(
      workflowId,
      buildMcpVideoNode({
        jobId: job.id,
        prompt: args.prompt,
        outputs,
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
  return { jobId: job.id, workflowId, videoUrls, outputs };
}

export async function runGenVideoI2V(args: VideoI2VInput): Promise<VideoResult> {
  const workflowId = args.workflowId || (await autoCreateWorkflow("ChatGPT I2V Generation"));
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
    nodeId: actionNodeId(),
    kind: "gen.video",
    data,
    inputs,
    workflowId,
  });
  const outputs = output.outputs ?? [];
  const videoUrls = outputs
    .map((o) => o.videoUrl)
    .filter((u): u is string => Boolean(u));
  if (videoUrls.length) {
    appendNodeBestEffort(
      workflowId,
      buildMcpVideoNode({
        jobId: job.id,
        prompt: args.prompt,
        outputs,
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
  return { jobId: job.id, workflowId, videoUrls, outputs };
}

export async function runGenVideoStartEnd(args: VideoStartEndInput): Promise<VideoResult> {
  const workflowId = args.workflowId || (await autoCreateWorkflow("ChatGPT StartEnd Generation"));
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
    nodeId: actionNodeId(),
    kind: "gen.start-end",
    data,
    inputs,
    workflowId,
  });
  const outputs = output.outputs ?? [];
  const videoUrls = outputs
    .map((o) => o.videoUrl)
    .filter((u): u is string => Boolean(u));
  if (videoUrls.length) {
    appendNodeBestEffort(
      workflowId,
      buildMcpVideoNode({
        jobId: job.id,
        prompt: args.prompt,
        outputs,
        kind: "gen.start-end",
        genMode: "i2v.veo",
        modelLabel: args.modelLabel,
        videoModelKey: args.videoModelKey,
        aspectRatio: args.aspectRatio,
      }),
      job.id,
    );
  }
  return { jobId: job.id, workflowId, videoUrls, outputs };
}

// ─── workflows ──────────────────────────────────────────────────────────────

export interface BuildWorkflowResult {
  workflowId: string;
  name: string;
  nodeIds: string[];
  edgeCount: number;
}

export async function runBuildWorkflow(args: BuildWorkflowInput): Promise<BuildWorkflowResult> {
  const workflowId = uid("wf");
  const now = Date.now();
  const snapshotNodes = args.nodes.map((n) => ({
    id: n.id,
    type: "wsNode" as const,
    position: { x: 0, y: 0 },
    data: {
      kind: n.kind as NodeKind,
      status: "idle" as const,
      origin: "mcp" as const,
      mcpCreatedAt: now,
      ...(n.data ?? {}),
    } as NodeDataBase,
  }));
  const snapshotEdges: SnapshotEdge[] = (args.edges ?? []).map((e, i) => ({
    id: `edge_${i}_${e.source}_${e.target}`,
    source: e.source,
    target: e.target,
    animated: true,
    style: { stroke: "#ff3c8e" },
  }));
  const ok = await writeFullSnapshot(workflowId, args.name, snapshotNodes, snapshotEdges);
  if (!ok) throw new Error("failed to write workflow snapshot");
  return {
    workflowId,
    name: args.name,
    nodeIds: snapshotNodes.map((n) => n.id),
    edgeCount: snapshotEdges.length,
  };
}

export interface WorkflowSummary {
  id: string;
  hasSnapshot: boolean;
  assetsCount: number;
  updatedAt: number | null;
}

export function listWorkflowsOnDisk(): WorkflowSummary[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
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
      return { id, hasSnapshot: existsSync(snapPath), assetsCount, updatedAt };
    });
}

export interface WorkflowDetail {
  workflowId: string;
  snapshot: unknown;
  assetsCount: number;
}

export function getWorkflowDetail(workflowIdRaw: string): WorkflowDetail | { error: string } {
  const id = sanitizeWorkflowId(workflowIdRaw);
  if (!id) return { error: `Invalid workflow id: ${workflowIdRaw}` };
  const snapPath = path.join(workflowDir(id), "snapshot.json");
  if (!existsSync(snapPath)) return { error: `No snapshot.json for workflow ${id}` };
  const raw = readFileSync(snapPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `snapshot.json for ${id} is not valid JSON` };
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
  return { workflowId: id, snapshot: parsed, assetsCount };
}

// ─── jobs ───────────────────────────────────────────────────────────────────

export function getJobById(jobId: string): JobRecord | null {
  return getJob(jobId) ?? null;
}

export function cancelJobById(jobId: string): { cancelled: boolean; reason?: string } {
  if (jobId === "*") {
    const n = cancelAllActiveJobs();
    return { cancelled: n > 0, reason: `${n} active jobs cancelled` };
  }
  const rec = getJob(jobId);
  if (!rec) return { cancelled: false, reason: `no job with id ${jobId}` };
  requestCancel(jobId);
  return { cancelled: true };
}

export function listAllJobs(): JobRecord[] {
  return listJobs();
}

// ─── auth / providers ────────────────────────────────────────────────────────

export interface AuthStatusSummary {
  veo: { ok: boolean; projectId: string | null; updatedAt: string | null };
  grok: { ok: boolean; profileName: string; updatedAt: string | null };
}

export function readAuthStatus(): AuthStatusSummary {
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

  return {
    veo: { ok: veoOk, projectId: veo?.projectId ?? null, updatedAt: veo?.updatedAt ?? null },
    grok: {
      ok: grokOk,
      profileName: GROK_PROFILE_NAME,
      updatedAt: grokEntry?.updated_at ?? null,
    },
  };
}

export interface OpenLoginResult {
  target: "veo" | "grok";
  port: number;
  userDataDir: string;
}

export async function openProviderLogin(
  target: "veo" | "grok",
  profileName?: string,
): Promise<OpenLoginResult> {
  if (target === "veo") {
    const handle = await openVeoChrome();
    return { target, port: handle.port, userDataDir: handle.userDataDir };
  }
  const handle = await openGrokChrome({ profileName: profileName || GROK_PROFILE_NAME });
  return { target, port: handle.port, userDataDir: handle.userDataDir };
}
