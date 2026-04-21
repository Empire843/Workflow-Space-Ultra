import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { NodeDataBase, NodeKind, OutputItem } from "@/lib/nodes";
import { sanitizeWorkflowId, workflowDir } from "@/server/paths/workflowAssets";

/**
 * Server-side helper that appends MCP-originated nodes into
 * `Workflows/<id>/snapshot.json`. The snapshot bridge is ordinarily a
 * one-way mirror from client → disk (see `src/app/api/workflows/[id]/snapshot/route.ts`),
 * but MCP flips that direction: generations that happen outside the browser
 * still need to surface on the user's canvas. Writing into snapshot.json with
 * a stable `data.origin = "mcp"` marker lets the client merge these nodes into
 * IndexedDB the next time the workflow is loaded.
 *
 * Design constraints:
 *   - Concurrent MCP tool calls may target the same workflow → serialise writes
 *     per workflowId via an in-memory promise chain.
 *   - Retry/resume safety → dedupe by `node.id` (`mcp_<jobId>`).
 *   - Never corrupt an existing snapshot → on JSON parse error, fall back to a
 *     skeleton rather than crashing (the client will re-PUT the authoritative
 *     graph on next save).
 */

// ─── types ──────────────────────────────────────────────────────────────────

/** Shape on disk — mirrors what the client PUTs in the snapshot route. */
interface SnapshotFile {
  id?: string;
  name?: string;
  nodes: SnapshotNode[];
  edges: unknown[];
  updatedAt?: number;
  syncedAt?: number;
  /** Marker so the client knows this snapshot was seeded by MCP before the
   *  canonical IDB push happens. Cleared on next client-initiated PUT. */
  fromMcp?: boolean;
}

interface SnapshotNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: NodeDataBase;
}

// ─── concurrency ────────────────────────────────────────────────────────────

/** Per-workflow serialisation queue. Keyed on workflowId → tail promise. */
const _locks = new Map<string, Promise<void>>();

/** Run `task` exclusively for a given workflowId. */
function withLock<T>(workflowId: string, task: () => Promise<T>): Promise<T> {
  const prev = _locks.get(workflowId) ?? Promise.resolve();
  const next = prev.then(task, task);
  // Record the tail as void-returning so we don't leak T across callers.
  _locks.set(
    workflowId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

// ─── layout ─────────────────────────────────────────────────────────────────

/** Horizontal spacing between successive MCP-appended nodes. */
const MCP_COL_STEP = 320;
/** Vertical row reserved for MCP-appended nodes when canvas is empty. */
const MCP_ROW_BASE = 200;
/** Fallback column when canvas is empty. */
const MCP_COL_BASE = 120;

function nextAutoLayoutPosition(existing: SnapshotNode[]): { x: number; y: number } {
  if (!existing.length) return { x: MCP_COL_BASE, y: MCP_ROW_BASE };
  // Place new nodes to the right of the right-most existing node so they don't
  // collide with any graph the user is working on. Keeping them on a single
  // row keeps them easy to spot.
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const n of existing) {
    const x = Number(n.position?.x ?? 0);
    const y = Number(n.position?.y ?? 0);
    if (Number.isFinite(x) && x > maxX) maxX = x;
    if (Number.isFinite(y) && y > maxY) maxY = y;
  }
  if (!Number.isFinite(maxX)) maxX = MCP_COL_BASE;
  if (!Number.isFinite(maxY)) maxY = MCP_ROW_BASE;
  return { x: maxX + MCP_COL_STEP, y: maxY };
}

// ─── factories ──────────────────────────────────────────────────────────────

export interface McpImageNodeInput {
  jobId: string;
  prompt?: string;
  outputs: OutputItem[];
  modelLabel?: string;
  aspectRatio?: string;
}

export interface McpVideoNodeInput {
  jobId: string;
  prompt?: string;
  outputs: OutputItem[];
  kind: "gen.video" | "gen.start-end";
  genMode?: NodeDataBase["genMode"];
  modelLabel?: string;
  videoModelKey?: string;
  aspectRatio?: string;
  resolution?: "480p" | "720p";
  videoLength?: number;
}

/** Canonical node id for MCP-originated nodes. Stable across retries so the
 *  merge path stays idempotent. */
export function mcpNodeIdForJob(jobId: string): string {
  return `mcp_${jobId}`;
}

export function buildMcpImageNode(input: McpImageNodeInput): SnapshotNode {
  const first = input.outputs[0];
  const data: NodeDataBase = {
    kind: "gen.image",
    status: "done",
    genMode: "t2i.veo",
    prompt: input.prompt,
    modelLabel: input.modelLabel,
    aspectRatio: input.aspectRatio,
    outputs: input.outputs,
    imageUrl: first?.imageUrl,
    imageMediaId: first?.imageMediaId,
    origin: "mcp",
    mcpJobId: input.jobId,
    mcpCreatedAt: Date.now(),
  };
  return {
    id: mcpNodeIdForJob(input.jobId),
    type: "wsNode",
    position: { x: 0, y: 0 },
    data,
  };
}

export function buildMcpVideoNode(input: McpVideoNodeInput): SnapshotNode {
  const first = input.outputs[0];
  const kind: NodeKind = input.kind;
  const data: NodeDataBase = {
    kind,
    status: "done",
    genMode: input.genMode,
    prompt: input.prompt,
    modelLabel: input.modelLabel,
    videoModelKey: input.videoModelKey,
    aspectRatio: input.aspectRatio,
    resolution: input.resolution,
    videoLength: input.videoLength,
    outputs: input.outputs,
    videoUrl: first?.videoUrl,
    videoHdUrl: first?.videoHdUrl,
    origin: "mcp",
    mcpJobId: input.jobId,
    mcpCreatedAt: Date.now(),
  };
  return {
    id: mcpNodeIdForJob(input.jobId),
    type: "wsNode",
    position: { x: 0, y: 0 },
    data,
  };
}

// ─── core ───────────────────────────────────────────────────────────────────

function readSnapshot(file: string): SnapshotFile | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Partial<SnapshotFile>;
    const nodes = Array.isArray(obj.nodes) ? (obj.nodes as SnapshotNode[]) : [];
    const edges = Array.isArray(obj.edges) ? (obj.edges as unknown[]) : [];
    return { ...obj, nodes, edges };
  } catch {
    // Corrupt snapshot — don't let MCP calls brick the workflow. Returning
    // null forces a fresh skeleton; the client's next PUT rewrites the file.
    return null;
  }
}

function emptySnapshot(workflowId: string): SnapshotFile {
  return {
    id: workflowId,
    name: "(auto)",
    nodes: [],
    edges: [],
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    fromMcp: true,
  };
}

/**
 * Append `node` to `Workflows/<workflowId>/snapshot.json`. Creates the file if
 * it does not exist. Deduplicates on `node.id` (no-op when already present).
 * Returns `true` when the file was actually mutated.
 */
export function appendMcpNodeToSnapshot(
  workflowId: string,
  node: SnapshotNode,
): Promise<boolean> {
  const safe = sanitizeWorkflowId(workflowId);
  if (!safe) return Promise.resolve(false);
  return withLock(safe, async () => {
    const dir = workflowDir(safe);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "snapshot.json");

    const snapshot = readSnapshot(file) ?? emptySnapshot(safe);
    const nodes = snapshot.nodes;

    if (nodes.some((n) => n.id === node.id)) {
      // Idempotent: same jobId already written (retry or parallel call).
      return false;
    }

    const positioned: SnapshotNode = {
      ...node,
      position: nextAutoLayoutPosition(nodes),
    };

    const next: SnapshotFile = {
      ...snapshot,
      id: snapshot.id ?? safe,
      name: snapshot.name ?? "(auto)",
      nodes: [...nodes, positioned],
      edges: snapshot.edges ?? [],
      updatedAt: Date.now(),
      syncedAt: Date.now(),
      // Keep `fromMcp` set only when the snapshot is still MCP-seeded. Once
      // the client PUTs a real graph it will clear this flag naturally.
      fromMcp: snapshot.fromMcp ?? !existsSync(file),
    };

    await writeFile(file, JSON.stringify(next), "utf-8");
    return true;
  });
}

// ─── full snapshot writer (build_workflow) ───────────────────────────────────

export interface SnapshotEdge {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
  style?: Record<string, unknown>;
}

/**
 * Auto-layout nodes in a left-to-right flow. Topologically sorts based on
 * edges and spaces nodes evenly.
 */
function autoLayoutNodes(
  nodes: SnapshotNode[],
  edges: SnapshotEdge[],
): SnapshotNode[] {
  const COL_WIDTH = 320;
  const ROW_HEIGHT = 220;
  const START_X = 100;
  const START_Y = 100;

  // Build adjacency: target → set of sources
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const e of edges) {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
    children.get(e.source)?.push(e.target);
  }

  // Topological sort (Kahn's algorithm) → columns
  const columns: string[][] = [];
  let queue = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const placed = new Set<string>();

  while (queue.length > 0) {
    columns.push([...queue]);
    const next: string[] = [];
    for (const id of queue) {
      placed.add(id);
      for (const child of children.get(id) ?? []) {
        const deg = (inDegree.get(child) ?? 1) - 1;
        inDegree.set(child, deg);
        if (deg <= 0 && !placed.has(child)) next.push(child);
      }
    }
    queue = next;
  }
  // Any nodes not placed (cycles or disconnected) go in last column
  for (const n of nodes) {
    if (!placed.has(n.id)) {
      if (!columns.length) columns.push([]);
      columns[columns.length - 1].push(n.id);
    }
  }

  // Assign positions
  const posMap = new Map<string, { x: number; y: number }>();
  for (let col = 0; col < columns.length; col++) {
    const ids = columns[col];
    for (let row = 0; row < ids.length; row++) {
      posMap.set(ids[row], {
        x: START_X + col * COL_WIDTH,
        y: START_Y + row * ROW_HEIGHT,
      });
    }
  }

  return nodes.map((n) => ({
    ...n,
    position: posMap.get(n.id) ?? n.position,
  }));
}

/**
 * Write a complete snapshot.json for a new workflow. Creates the directory if
 * needed. All nodes are marked with `origin: "mcp"`.
 */
export function writeFullSnapshot(
  workflowId: string,
  name: string,
  nodes: SnapshotNode[],
  edges: SnapshotEdge[],
): Promise<boolean> {
  const safe = sanitizeWorkflowId(workflowId);
  if (!safe) return Promise.resolve(false);
  return withLock(safe, async () => {
    const dir = workflowDir(safe);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "snapshot.json");

    const layouted = autoLayoutNodes(nodes, edges);

    const snapshot: SnapshotFile = {
      id: safe,
      name,
      nodes: layouted,
      edges,
      updatedAt: Date.now(),
      syncedAt: Date.now(),
      fromMcp: true,
    };

    await writeFile(file, JSON.stringify(snapshot), "utf-8");
    return true;
  });
}

