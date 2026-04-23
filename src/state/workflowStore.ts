"use client";

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { create } from "zustand";

import { NODE_CATALOG, type GenMode, type NodeDataBase, type NodeKind } from "@/lib/nodes";
import { VEO_I2V_DEFAULT_LABEL } from "@/lib/veoVideoModels";
import { uid } from "@/lib/utils";
import {
  getWorkflow,
  putWorkflow,
  deleteWorkflowRecord,
  duplicateWorkflowRecord,
  type WorkflowRecord,
} from "@/lib/db";

export type WSNode = Node<NodeDataBase>;
export type WSEdge = Edge;

// ---------------------------------------------------------------------------
// Runtime-only fields stripped from persisted data to save space.
// ---------------------------------------------------------------------------
const RUNTIME_KEYS: (keyof NodeDataBase)[] = [
  "status",
  "statusLog",
  "progress",
  "error",
  "outputsOverflow",
  "uploadBase64",
  "jobId",
  // Frame live-progress fields — only meaningful while runFrame is in flight.
  "frameRunning",
  "frameRunIndex",
  "frameRunTotal",
  "frameRunCurrentLabel",
];

const RUNTIME_KEY_SET = new Set<string>(RUNTIME_KEYS as unknown as string[]);

/**
 * A patch is "runtime-only" when it touches nothing except RUNTIME_KEYS.
 * Progress ticks and SSE status updates fall in this bucket and should NOT
 * reschedule the debounced IndexedDB save — otherwise every running job
 * triggers a write per second per node.
 */
function isRuntimeOnlyPatch(patch: Partial<NodeDataBase>): boolean {
  for (const k of Object.keys(patch)) {
    if (!RUNTIME_KEY_SET.has(k)) return false;
  }
  return true;
}

function stripRuntimeFields(nodes: WSNode[]): WSNode[] {
  return nodes.map((n) => {
    const cleaned = { ...n.data };
    for (const k of RUNTIME_KEYS) {
      delete (cleaned as Record<string, unknown>)[k];
    }
    return { ...n, data: cleaned };
  });
}

// ---------------------------------------------------------------------------
// Node data migration
// ---------------------------------------------------------------------------
/**
 * The Text→Video and Image→Video nodes were consolidated into a single
 * `gen.video` node per provider — the executor auto-routes on upstream
 * images. Any previously-saved `i2v.veo` / `i2v.grok` workflow is rewritten
 * to the matching `t2v.*` genMode on load so the behavior stays identical
 * (connecting an image node still runs the I2V pipeline) without leaving the
 * deprecated option visible in the inspector dropdown.
 */
/**
 * Strip the `data:<mime>;base64,` prefix from a data URL, returning just the
 * raw base64 payload. `content.upload` stores the payload without the prefix
 * on `data.uploadBase64` so `executor.resolveVeoMediaId` can forward it to
 * the provider upload endpoints unchanged. If no prefix is present (already
 * a raw payload) the string is returned as-is.
 */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return dataUrl;
  const header = dataUrl.slice(0, comma);
  return header.startsWith("data:") ? dataUrl.slice(comma + 1) : dataUrl;
}

function migrateNodes(nodes: WSNode[]): WSNode[] {
  let changed = false;
  const out: WSNode[] = nodes.map((n) => {
    let next: WSNode = n;
    const mode = (n.data as { genMode?: string }).genMode;
    if (mode === "i2v.veo" || mode === "i2v.grok") {
      const canonical = mode === "i2v.veo" ? "t2v.veo" : "t2v.grok";
      next = { ...next, data: { ...next.data, genMode: canonical } } as WSNode;
      changed = true;
    }
    // Earlier Frame implementation set `extent: "parent"` + `expandParent:
    // true` on frame children, which caused React Flow to clamp / grow the
    // parent during drag — producing the "jumpy drag" bug. We no longer rely
    // on those flags; strip them from loaded snapshots so previously-saved
    // workflows benefit from the fix without requiring a manual re-drag.
    const hasExtent = (next as { extent?: unknown }).extent !== undefined;
    const hasExpand = (next as { expandParent?: boolean }).expandParent !== undefined;
    if (hasExtent || hasExpand) {
      const copy = { ...next } as WSNode;
      delete (copy as { extent?: unknown }).extent;
      delete (copy as { expandParent?: boolean }).expandParent;
      next = copy;
      changed = true;
    }
    return next;
  });
  return changed ? out : nodes;
}

// ---------------------------------------------------------------------------
// Snapshot bridge — mirror graph to Workflows/<id>/snapshot.json so the
// Node-side MCP server can serve it. Coalesce overlapping POSTs per id.
// ---------------------------------------------------------------------------
const _snapshotInflight = new Map<string, Promise<void>>();

/**
 * Fetch `Workflows/<id>/snapshot.json` and return any nodes the server has
 * appended via MCP (`data.origin === "mcp"`) that are not already present in
 * the given id set. The snapshot bridge is otherwise client→server, but MCP
 * reverses direction for generations that run outside the browser; these
 * nodes are materialised on the canvas the next time the workflow is loaded.
 *
 * Silently returns `[]` when:
 *   - the snapshot file doesn't exist yet (workflow has never been opened
 *     server-side),
 *   - the response is malformed,
 *   - or the network call fails.
 *
 * Any of these are expected during normal operation and must never block
 * `loadWorkflow` — the IndexedDB graph is always the authoritative source.
 */
export async function fetchMcpSnapshotDelta(
  id: string,
  existingIds: Set<string>,
): Promise<WSNode[]> {
  try {
    const res = await fetch(
      `/api/workflows/${encodeURIComponent(id)}/snapshot`,
      { method: "GET", headers: { accept: "application/json" } },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; snapshot?: unknown };
    if (!body?.ok || !body.snapshot || typeof body.snapshot !== "object") return [];
    const snapshot = body.snapshot as { nodes?: unknown };
    if (!Array.isArray(snapshot.nodes)) return [];
    const delta: WSNode[] = [];
    for (const raw of snapshot.nodes) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as WSNode;
      if (!node.id || !node.data) continue;
      if (existingIds.has(node.id)) continue;
      if ((node.data as NodeDataBase).origin !== "mcp") continue;
      // Ensure the node has a shape the canvas can render. React Flow keys
      // every node by id + reuses a single renderer (`wsNode`), so we normalise
      // both here rather than trusting whatever the server wrote.
      delta.push({
        ...node,
        type: node.type ?? "wsNode",
        position: node.position ?? { x: 0, y: 0 },
      });
    }
    return delta;
  } catch {
    return [];
  }
}

async function pushWorkflowSnapshot(
  id: string,
  name: string,
  nodes: unknown[],
  edges: unknown[],
): Promise<void> {
  // If a previous POST for this id is still in flight, skip — the newest save
  // will fire again in a moment and produce a fresher snapshot anyway.
  if (_snapshotInflight.has(id)) return;
  const body = JSON.stringify({ name, nodes, edges, updatedAt: Date.now() });
  const promise = fetch(`/api/workflows/${encodeURIComponent(id)}/snapshot`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      _snapshotInflight.delete(id);
    });
  _snapshotInflight.set(id, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Debounced auto-save
// ---------------------------------------------------------------------------
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 1000;

function scheduleSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const { activeWorkflowId, _saveCurrentWorkflow } = useWorkflowStore.getState();
    if (activeWorkflowId) {
      void _saveCurrentWorkflow();
    }
  }, SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Undo / Redo history
// ---------------------------------------------------------------------------
interface HistorySnapshot {
  nodes: WSNode[];
  edges: WSEdge[];
}

const MAX_HISTORY = 50;

// Tracks whether we've already snapshotted the CURRENT drag gesture so we only
// push one undo step per drag (not per intermediate position change).
let _dragSnapshotTaken = false;

// ---------------------------------------------------------------------------
// Frame re-parenting
// ---------------------------------------------------------------------------
/**
 * Measured dimensions for a child node we couldn't probe via React Flow's
 * `measured`. Good enough for hit-testing.
 */
const DEFAULT_CHILD_W = 240;
const DEFAULT_CHILD_H = 160;

interface AbsoluteBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function nodeAbsolutePosition(
  node: WSNode,
  byId: Map<string, WSNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  // Walk up the parent chain so a grand-child contributes to the real coord.
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function frameAbsoluteBounds(frame: WSNode, byId: Map<string, WSNode>): AbsoluteBounds {
  const pos = nodeAbsolutePosition(frame, byId);
  const d = frame.data as NodeDataBase;
  const styleW = (frame.style as { width?: number } | undefined)?.width;
  const styleH = (frame.style as { height?: number } | undefined)?.height;
  const w =
    (typeof styleW === "number" ? styleW : undefined) ??
    frame.width ??
    frame.measured?.width ??
    d.frameWidth ??
    600;
  const h =
    (typeof styleH === "number" ? styleH : undefined) ??
    frame.height ??
    frame.measured?.height ??
    d.frameHeight ??
    400;
  return { left: pos.x, top: pos.y, right: pos.x + w, bottom: pos.y + h };
}

function rectArea(b: AbsoluteBounds): number {
  return Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
}

/**
 * Find the smallest Frame whose absolute bounds contain the given point.
 * "Smallest" so dropping into an inner frame works when frames overlap.
 * Returns `null` if no frame contains the point. Frames in `excludeIds` are
 * skipped (used to avoid parenting a frame to itself when dragged).
 */
function findContainingFrame(
  nodes: WSNode[],
  point: { x: number; y: number },
  excludeIds: Set<string> = new Set(),
): { frame: WSNode; bounds: AbsoluteBounds } | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let target: { frame: WSNode; bounds: AbsoluteBounds } | null = null;
  for (const n of nodes) {
    if ((n.data as NodeDataBase).kind !== "frame") continue;
    if (excludeIds.has(n.id)) continue;
    const b = frameAbsoluteBounds(n, byId);
    if (point.x >= b.left && point.x <= b.right && point.y >= b.top && point.y <= b.bottom) {
      if (!target || rectArea(b) < rectArea(target.bounds)) {
        target = { frame: n, bounds: b };
      }
    }
  }
  return target;
}

/**
 * After a drag ends, re-compute parentId for each dragged node so that a node
 * dropped on top of a Frame becomes its child and a node dragged out detaches.
 *
 * Rules:
 *   - Frame nodes themselves are never re-parented (no nested Frames yet).
 *   - Re-parent when the node's centre is inside a Frame; prefer the smallest
 *     matching Frame when multiple overlap.
 *   - Positions are converted between absolute (no parent) and frame-relative
 *     (parent = frame) so the node stays visually in place.
 *
 * NOTE: We deliberately do NOT set `extent: "parent"` or `expandParent: true`.
 * Both of those make React Flow clamp / expand DURING the drag, which causes
 * visible jumps when the cursor moves near the frame edge. Leaving them off
 * lets the user drag a child anywhere freely; dropping it outside the frame
 * simply detaches on dragEnd via this function.
 */
function reparentDraggedNodes(nodes: WSNode[], draggedIds: string[]): WSNode[] {
  if (!draggedIds.length) return nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  let mutated = false;
  const nextNodes = nodes.map((node) => {
    if (!draggedIds.includes(node.id)) return node;
    if ((node.data as NodeDataBase).kind === "frame") return node;

    // Absolute position + centre for hit-testing.
    const abs = nodeAbsolutePosition(node, byId);
    const w = node.width ?? node.measured?.width ?? DEFAULT_CHILD_W;
    const h = node.height ?? node.measured?.height ?? DEFAULT_CHILD_H;
    const centre = { x: abs.x + w / 2, y: abs.y + h / 2 };

    const target = findContainingFrame(nodes, centre, new Set([node.id]));
    const nextParentId = target?.frame.id;
    if (nextParentId === node.parentId) return node;
    mutated = true;

    if (nextParentId) {
      // Enter the frame: convert absolute pos → frame-relative pos.
      const rel = {
        x: abs.x - target!.bounds.left,
        y: abs.y - target!.bounds.top,
      };
      const next = { ...node, parentId: nextParentId, position: rel } as WSNode;
      // Ensure stale extent/expandParent flags from older snapshots are wiped.
      delete (next as { extent?: unknown }).extent;
      delete (next as { expandParent?: boolean }).expandParent;
      return next;
    }
    // Leave frame: position is already absolute (abs); clear parent hints.
    const next = { ...node, position: abs } as WSNode;
    delete (next as { parentId?: string }).parentId;
    delete (next as { extent?: unknown }).extent;
    delete (next as { expandParent?: boolean }).expandParent;
    return next;
  });

  return mutated ? nextNodes : nodes;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export type CanvasTool = "select" | "pan";

interface WorkflowState {
  activeWorkflowId: string | null;
  activeWorkflowName: string;
  nodes: WSNode[];
  edges: WSEdge[];
  selectedNodeId: string | null;

  // Transient UI state (not persisted)
  canvasTool: CanvasTool;
  showMinimap: boolean;

  // Undo/redo
  _past: HistorySnapshot[];
  _future: HistorySnapshot[];
  canUndo: boolean;
  canRedo: boolean;

  setNodes: (n: WSNode[]) => void;
  setEdges: (e: WSEdge[]) => void;
  addNode: (kind: NodeKind, position: { x: number; y: number }, extra?: Partial<NodeDataBase>) => string;
  addNodes: (nodes: WSNode[]) => void;
  addEdges: (edges: WSEdge[]) => void;
  importScenes: (args: {
    imagePrompts: string[];
    videoPrompts: string[];
    imageGenMode: GenMode;
    videoGenMode: GenMode;
    /**
     * Aspect ratio applied uniformly to every gen.image and gen.video node
     * in this batch. Only the 3 backend-supported ratios are accepted —
     * 2:3/3:2/etc. would be silently coerced to LANDSCAPE by the VEO
     * executor, so the Import dialog restricts the dropdown to these.
     */
    aspectRatio: "16:9" | "9:16" | "1:1";
    anchor: { x: number; y: number };
    groupInFrame: boolean;
    /**
     * Shared "character / style sheet" text. When present, a single
     * `content.text` node is created at the top of the Frame and wired into
     * EVERY gen.image + gen.video child, so its content is concatenated in
     * front of each scene-specific prompt via the normal upstream-text
     * pipeline. Edit once, updates all scenes.
     */
    stylePrefix?: string;
    /**
     * Shared reference images (e.g. character portrait, mood board). Each
     * becomes a `content.upload` node wired as input to every gen.image in
     * the batch. Nano Banana 2 / pro use them as identity/style anchors.
     * Imagen silently drops them.
     */
    referenceImages?: Array<{ dataUrl: string; mime: string; name?: string }>;
  }) => void;
  cloneNode: (sourceId: string, offsetIndex: number, extra?: Partial<NodeDataBase>) => WSNode | null;
  updateNodeData: (id: string, data: Partial<NodeDataBase>) => void;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;

  setCanvasTool: (tool: CanvasTool) => void;
  toggleMinimap: () => void;

  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;

  clearAll: () => void;

  undo: () => void;
  redo: () => void;
  _takeSnapshot: () => void;
  _clearHistory: () => void;

  // Multi-workflow actions
  loadWorkflow: (id: string) => Promise<boolean>;
  createWorkflow: (name?: string) => Promise<string>;
  deleteWorkflow: (id: string) => Promise<void>;
  duplicateWorkflow: (id: string) => Promise<string | null>;
  renameWorkflow: (id: string, name: string) => Promise<void>;
  goToDashboard: () => Promise<void>;
  _saveCurrentWorkflow: () => Promise<void>;
}

export const useWorkflowStore = create<WorkflowState>()(
  (set, get) => ({
    activeWorkflowId: null,
    activeWorkflowName: "",
    nodes: [],
    edges: [],
    selectedNodeId: null,

    // Transient UI state
    canvasTool: "select" as CanvasTool,
    showMinimap: false,

    _past: [],
    _future: [],
    canUndo: false,
    canRedo: false,

    _takeSnapshot: () => {
      const { nodes, edges, _past } = get();
      const snap: HistorySnapshot = { nodes, edges };
      const nextPast = [..._past, snap];
      // Keep history bounded to avoid unbounded memory on long sessions.
      if (nextPast.length > MAX_HISTORY) nextPast.splice(0, nextPast.length - MAX_HISTORY);
      set({ _past: nextPast, _future: [], canUndo: true, canRedo: false });
    },

    _clearHistory: () => {
      _dragSnapshotTaken = false;
      set({ _past: [], _future: [], canUndo: false, canRedo: false });
    },

    undo: () => {
      const { _past, _future, nodes, edges } = get();
      if (!_past.length) return;
      const prev = _past[_past.length - 1];
      const nextPast = _past.slice(0, -1);
      const nextFuture = [..._future, { nodes, edges }];
      set({
        nodes: prev.nodes,
        edges: prev.edges,
        _past: nextPast,
        _future: nextFuture,
        canUndo: nextPast.length > 0,
        canRedo: true,
      });
      scheduleSave();
    },

    redo: () => {
      const { _past, _future, nodes, edges } = get();
      if (!_future.length) return;
      const next = _future[_future.length - 1];
      const nextFuture = _future.slice(0, -1);
      const nextPast = [..._past, { nodes, edges }];
      set({
        nodes: next.nodes,
        edges: next.edges,
        _past: nextPast,
        _future: nextFuture,
        canUndo: true,
        canRedo: nextFuture.length > 0,
      });
      scheduleSave();
    },

    setCanvasTool: (tool) => set({ canvasTool: tool }),
    toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),

    setNodes: (n) => {
      get()._takeSnapshot();
      set({ nodes: n });
      scheduleSave();
    },
    setEdges: (e) => {
      get()._takeSnapshot();
      set({ edges: e });
      scheduleSave();
    },

    addNode: (kind, position, extra) => {
      get()._takeSnapshot();
      const id = uid("node");
      const catalogEntry = NODE_CATALOG.find((e) => e.kind === kind);
      const genMode = extra?.genMode || catalogEntry?.defaultGenMode;
      // Frame nodes use a dedicated renderer (`frame`) and carry their size
      // both in `style` (so React Flow lays them out) and in `data` (so the
      // persisted snapshot round-trips even if `style` gets stripped).
      if (kind === "frame") {
        const existingFrames = get().nodes.filter(
          (n) => (n.data as NodeDataBase).kind === "frame",
        ).length;
        const w = typeof extra?.frameWidth === "number" ? extra.frameWidth : 600;
        const h = typeof extra?.frameHeight === "number" ? extra.frameHeight : 400;
        const label =
          typeof extra?.frameLabel === "string" && extra.frameLabel.length
            ? extra.frameLabel
            : `Frame ${existingFrames + 1}`;
        const node: WSNode = {
          id,
          type: "frame",
          position,
          // Keep Frame *below* any wsNode children on the z-axis so media
          // previews stay legible. React Flow reads `zIndex` off the node.
          zIndex: -1,
          style: { width: w, height: h },
          data: {
            kind: "frame",
            status: "idle",
            frameLabel: label,
            frameWidth: w,
            frameHeight: h,
            ...extra,
          },
        };
        set({ nodes: [...get().nodes, node] });
        scheduleSave();
        return id;
      }
      // Auto-parent: if the creation point lands inside a Frame's absolute
      // bounds, make the new node a child of that Frame. Without this, nodes
      // dropped onto a Frame (from the toolbar, the quick-add menu, or a
      // shortcut whose position happens to intersect a Frame) would only
      // *visually* overlap the Frame but not be logically contained — so
      // "Run Frame" would see zero children and moving the Frame wouldn't
      // carry them along. The position we receive is always in absolute
      // canvas coords (`screenToFlowPosition`), so comparing directly
      // against `frameAbsoluteBounds` is correct.
      const hit = findContainingFrame(get().nodes, position);
      const pos = hit
        ? { x: position.x - hit.bounds.left, y: position.y - hit.bounds.top }
        : position;
      const node: WSNode = {
        id,
        type: "wsNode",
        position: pos,
        ...(hit ? { parentId: hit.frame.id } : {}),
        data: { kind, status: "idle", ...(genMode ? { genMode } : {}), ...extra },
      };
      set({ nodes: [...get().nodes, node] });
      scheduleSave();
      return id;
    },

    addNodes: (ns) => {
      get()._takeSnapshot();
      set({ nodes: [...get().nodes, ...ns] });
      scheduleSave();
    },
    addEdges: (es) => {
      get()._takeSnapshot();
      set({ edges: [...get().edges, ...es] });
      scheduleSave();
    },

    importScenes: ({
      imagePrompts,
      videoPrompts,
      imageGenMode,
      videoGenMode,
      aspectRatio,
      anchor,
      groupInFrame,
      stylePrefix,
      referenceImages,
    }) => {
      const n = Math.min(imagePrompts.length, videoPrompts.length);
      if (n === 0) return;

      // Layout: 4 columns per scene, stacked vertically.
      // col 0: Text (image prompt)  → col 1: gen.image  → col 2: Text (video prompt)  → col 3: gen.video
      // Edges: textImg→genImage, genImage→genVideo, textVid→genVideo
      const COL_W = 320;
      // Row height has to clear the tallest node on the row. gen.image and
      // gen.video both scale with aspectRatio (see FRAME_DIMS in WSNode):
      //   16:9 → 158h, 1:1 → 220h, 9:16 → 320h  (preview area only)
      // plus ~40px chrome (NodeLabel header + handle padding). A hard-coded
      // 260 used to work for 16:9 only and caused the 9:16 rows to overlap
      // by ~100px. Pick a per-ratio row height with ~60–80px gap so labels
      // and handles never collide with the row below.
      const ROW_H =
        aspectRatio === "9:16" ? 440 : aspectRatio === "1:1" ? 320 : 260;
      const FRAME_PAD_X = 40;
      const FRAME_PAD_Y = 60; // extra top padding so the frame title bar doesn't cover row 0
      const COLS = 4;

      // Optional header row (stylePrefix text + reference upload nodes) — one
      // extra row above all scenes, so everyone downstream inherits them.
      const hasStyle = !!stylePrefix && stylePrefix.trim().length > 0;
      const refs = (referenceImages ?? []).filter((r) => r.dataUrl);
      const hasRefs = refs.length > 0;
      const hasHeader = hasStyle || hasRefs;
      const headerRowY = 0;
      const sceneStartRowIdx = hasHeader ? 1 : 0;

      get()._takeSnapshot();

      const newNodes: WSNode[] = [];
      const newEdges: WSEdge[] = [];

      // Optional wrapping frame. When present, child positions are frame-relative.
      let frameId: string | null = null;
      if (groupInFrame) {
        frameId = uid("node");
        const frameW = COLS * COL_W + FRAME_PAD_X * 2;
        const frameH = (n + sceneStartRowIdx) * ROW_H + FRAME_PAD_Y + FRAME_PAD_X;
        const existingFrames = get().nodes.filter(
          (nd) => (nd.data as NodeDataBase).kind === "frame",
        ).length;
        const label = `Scenes ${existingFrames + 1}`;
        newNodes.push({
          id: frameId,
          type: "frame",
          position: { x: anchor.x, y: anchor.y },
          zIndex: -1,
          style: { width: frameW, height: frameH },
          data: {
            kind: "frame",
            status: "idle",
            frameLabel: label,
            frameWidth: frameW,
            frameHeight: frameH,
          },
        });
      }

      // Base offset for child positions.
      // - Inside frame: relative to frame top-left, with padding so nodes sit
      //   below the frame title bar and inside the right/bottom edges.
      // - Without frame: absolute canvas coords anchored at `anchor`.
      const baseX = groupInFrame ? FRAME_PAD_X : anchor.x;
      const baseY = groupInFrame ? FRAME_PAD_Y : anchor.y;

      // Header row: shared style text (col 0) + reference upload nodes
      // (col 1..K). These IDs are collected so every scene's gen.image and
      // gen.video can reference them via edges further down.
      let styleTextId: string | null = null;
      const refUploadIds: string[] = [];

      if (hasHeader) {
        const headerY = baseY + headerRowY * ROW_H;

        if (hasStyle) {
          styleTextId = uid("node");
          newNodes.push({
            id: styleTextId,
            type: "wsNode",
            position: { x: baseX + 0 * COL_W, y: headerY },
            ...(frameId ? { parentId: frameId } : {}),
            data: {
              kind: "content.text",
              status: "idle",
              label: "Shared style / character sheet",
              text: stylePrefix!.trim(),
            },
          });
        }

        // Reference images: lay out in cols 1..N of the header row; if they
        // don't all fit (K > 3), wrap by reducing column width slightly —
        // simplest is to cap at 3 cols in a single row for the happy path.
        // Users rarely upload more than 2-3 refs in practice.
        refs.forEach((ref, idx) => {
          const uploadId = uid("node");
          refUploadIds.push(uploadId);
          const col = 1 + idx; // col 0 is the style text
          newNodes.push({
            id: uploadId,
            type: "wsNode",
            position: { x: baseX + col * COL_W, y: headerY },
            ...(frameId ? { parentId: frameId } : {}),
            data: {
              kind: "content.upload",
              status: "idle",
              label: ref.name
                ? `Reference · ${ref.name}`
                : `Reference #${idx + 1}`,
              // `uploadBase64` should hold just the base64 payload (no
              // `data:` prefix) — matches what executor.resolveVeoMediaId
              // expects. The raw dataUrl is also kept on `imageUrl` so the
              // node's media preview renders without a round-trip.
              uploadBase64: stripDataUrlPrefix(ref.dataUrl),
              uploadMime: ref.mime,
              uploadAccept: "image/*",
              imageUrl: ref.dataUrl,
            },
          });
        });
      }

      for (let i = 0; i < n; i++) {
        const y = baseY + (i + sceneStartRowIdx) * ROW_H;
        const imgPrompt = imagePrompts[i] ?? "";
        const vidPrompt = videoPrompts[i] ?? "";

        const textImgId = uid("node");
        const genImgId = uid("node");
        const textVidId = uid("node");
        const genVidId = uid("node");

        const parentProps = frameId ? { parentId: frameId } : {};

        newNodes.push({
          id: textImgId,
          type: "wsNode",
          position: { x: baseX + 0 * COL_W, y },
          ...parentProps,
          data: {
            kind: "content.text",
            status: "idle",
            label: `Scene ${i + 1} · Image prompt`,
            text: imgPrompt,
          },
        });

        newNodes.push({
          id: genImgId,
          type: "wsNode",
          position: { x: baseX + 1 * COL_W, y },
          ...parentProps,
          data: {
            kind: "gen.image",
            status: "idle",
            genMode: imageGenMode,
            label: `Scene ${i + 1} · Image`,
            aspectRatio,
          },
        });

        newNodes.push({
          id: textVidId,
          type: "wsNode",
          position: { x: baseX + 2 * COL_W, y },
          ...parentProps,
          data: {
            kind: "content.text",
            status: "idle",
            label: `Scene ${i + 1} · Video prompt`,
            text: vidPrompt,
          },
        });

        // For VEO video we pin the default to the free "Lower Priority" tier
        // so batch imports don't silently burn Fast credits. Grok has its own
        // label set lazily by the inspector. I2V default is used when an image
        // is upstream; here the upstream is always gen.image, so use I2V.
        const isVeoVideo = videoGenMode === "t2v.veo";
        newNodes.push({
          id: genVidId,
          type: "wsNode",
          position: { x: baseX + 3 * COL_W, y },
          ...parentProps,
          data: {
            kind: "gen.video",
            status: "idle",
            genMode: videoGenMode,
            label: `Scene ${i + 1} · Video`,
            aspectRatio,
            ...(isVeoVideo ? { modelLabel: VEO_I2V_DEFAULT_LABEL } : {}),
          },
        });

        const edgeStyle = { animated: true, style: { stroke: "#ff3c8e" } };
        // Header-row fan-out FIRST so the shared style text appears at the
        // head of the concatenated prompt (buildCombinedPrompt joins upstream
        // text in edge order). This also means reference uploads are resolved
        // before the per-scene text.
        if (styleTextId) {
          newEdges.push({
            id: uid("edge"),
            source: styleTextId,
            target: genImgId,
            ...edgeStyle,
          });
          newEdges.push({
            id: uid("edge"),
            source: styleTextId,
            target: genVidId,
            ...edgeStyle,
          });
        }
        for (const refId of refUploadIds) {
          // Refs only wire to gen.image: Nano Banana takes them via
          // `imageInputs`. Feeding them to gen.video would collide with
          // the I2V start-frame slot, which is already filled by the
          // scene's own gen.image output via the genImage → genVideo
          // edge below.
          newEdges.push({
            id: uid("edge"),
            source: refId,
            target: genImgId,
            ...edgeStyle,
          });
        }
        newEdges.push({
          id: uid("edge"),
          source: textImgId,
          target: genImgId,
          ...edgeStyle,
        });
        newEdges.push({
          id: uid("edge"),
          source: genImgId,
          target: genVidId,
          ...edgeStyle,
        });
        newEdges.push({
          id: uid("edge"),
          source: textVidId,
          target: genVidId,
          ...edgeStyle,
        });
      }

      set({
        nodes: [...get().nodes, ...newNodes],
        edges: [...get().edges, ...newEdges],
      });
      scheduleSave();
    },

    cloneNode: (sourceId, offsetIndex, extra) => {
      const src = get().nodes.find((n) => n.id === sourceId);
      if (!src) return null;
      get()._takeSnapshot();
      const id = uid("node");
      // Offsets are applied in whatever coord space the source uses, so a
      // clone of a framed node stays inside the same frame (coords are
      // relative to the frame). Inherit parentId so React Flow renders the
      // clone attached to the same group.
      const pos = {
        x: (src.position.x || 0) + 280 * offsetIndex,
        y: (src.position.y || 0) + (offsetIndex % 2 === 0 ? 0 : 30),
      };
      const cloned: WSNode = {
        id,
        type: "wsNode",
        position: pos,
        ...(src.parentId ? { parentId: src.parentId } : {}),
        data: {
          ...src.data,
          ...extra,
          status: "idle",
          progress: 0,
          error: undefined,
          outputs: undefined,
          imageUrl: undefined,
          imageMediaId: undefined,
          videoUrl: undefined,
          videoHdUrl: undefined,
        },
      };
      set({ nodes: [...get().nodes, cloned] });
      scheduleSave();
      return cloned;
    },

    updateNodeData: (id, data) => {
      const runtimeOnly = isRuntimeOnlyPatch(data);
      // Skip snapshots for runtime-only progress/status ticks — they'd pollute
      // the undo stack with uninteresting states and bury the user's last edit.
      if (!runtimeOnly) get()._takeSnapshot();
      set({
        nodes: get().nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n
        ),
      });
      if (!runtimeOnly) scheduleSave();
    },

    removeNode: (id) => {
      get()._takeSnapshot();
      const removed = get().nodes.find((n) => n.id === id);
      // Deleting a Frame also deletes every child it currently contains so
      // users don't end up with orphan nodes whose `parentId` points at a
      // missing Frame (React Flow then stops rendering them).
      const removeIds = new Set<string>([id]);
      if (removed && (removed.data as NodeDataBase).kind === "frame") {
        for (const n of get().nodes) {
          if (n.parentId === id) removeIds.add(n.id);
        }
      }
      set({
        nodes: get().nodes.filter((n) => !removeIds.has(n.id)),
        edges: get().edges.filter(
          (e) => !removeIds.has(e.source) && !removeIds.has(e.target),
        ),
        selectedNodeId: removeIds.has(get().selectedNodeId ?? "")
          ? null
          : get().selectedNodeId,
      });
      scheduleSave();
    },

    selectNode: (id) => set({ selectedNodeId: id }),

    onNodesChange: (changes) => {
      // Decide if THIS change batch should push an undo snapshot. React Flow
      // fires many `position` changes while dragging (one per frame) → we only
      // want ONE undo step for the whole drag. Strategy:
      //   • `dragging: true` from React Flow → snapshot once per gesture
      //   • `dragging: false` (drag end) → reset the per-gesture flag, no snapshot
      //   • `remove` / `reset` / `add` → always snapshot (discrete ops)
      //   • `select` / `dimensions` only → ignore (transient UI)
      let snapshotWorthy = false;
      let dragStart = false;
      let dragEnd = false;
      const draggedIds: string[] = [];
      for (const c of changes) {
        if (c.type === "position") {
          if (c.dragging) dragStart = true;
          else {
            dragEnd = true;
            if (c.id) draggedIds.push(c.id);
          }
        } else if (c.type === "remove" || c.type === "add" || c.type === "replace") {
          snapshotWorthy = true;
        }
      }
      if (dragStart && !_dragSnapshotTaken) {
        get()._takeSnapshot();
        _dragSnapshotTaken = true;
      } else if (snapshotWorthy) {
        get()._takeSnapshot();
      }
      if (dragEnd) _dragSnapshotTaken = false;

      let nextNodes = applyNodeChanges(changes, get().nodes) as WSNode[];

      // Frame re-parenting — on drag end, check every node that just moved and
      // see if it now sits inside a Frame's bounding box. We:
      //   • Attach the node to the top-most Frame containing its centre (by
      //     converting the dropped centre to absolute coords and finding the
      //     smallest Frame that covers it).
      //   • Detach it from any existing Frame if it's been dragged out.
      // Frames themselves are never re-parented (nested Frames aren't
      // supported right now — keep the pre-condition strict).
      if (dragEnd && draggedIds.length > 0) {
        nextNodes = reparentDraggedNodes(nextNodes, draggedIds);
      }

      // If the selected node is removed (via Delete/Backspace or
      // drag-select + delete), clear selectedNodeId so NodeInspector hides.
      const removedIds = changes
        .filter((c): c is { type: "remove"; id: string } => c.type === "remove")
        .map((c) => c.id);
      const currentSelected = get().selectedNodeId;
      const patch: { nodes: WSNode[]; selectedNodeId?: string | null } = {
        nodes: nextNodes,
      };
      if (currentSelected && removedIds.includes(currentSelected)) {
        patch.selectedNodeId = null;
      }
      set(patch);
      scheduleSave();
    },
    onEdgesChange: (changes) => {
      const snapshotWorthy = changes.some(
        (c) => c.type === "remove" || c.type === "add" || c.type === "replace",
      );
      if (snapshotWorthy) get()._takeSnapshot();
      set({ edges: applyEdgeChanges(changes, get().edges) });
      scheduleSave();
    },
    onConnect: (conn) => {
      get()._takeSnapshot();
      set({ edges: addEdge({ ...conn, animated: true, style: { stroke: "#ff3c8e" } }, get().edges) });
      scheduleSave();
    },

    clearAll: () => {
      get()._takeSnapshot();
      set({ nodes: [], edges: [], selectedNodeId: null });
      scheduleSave();
    },

    // ----- Multi-workflow -----

    loadWorkflow: async (id: string) => {
      const rec = await getWorkflow(id);
      if (!rec) return false;
      const idbNodes = migrateNodes((rec.data.nodes ?? []) as WSNode[]);
      set({
        activeWorkflowId: rec.id,
        activeWorkflowName: rec.name,
        nodes: idbNodes,
        edges: (rec.data.edges ?? []) as WSEdge[],
        selectedNodeId: null,
      });
      get()._clearHistory();
      _persistActiveId(rec.id);

      // Merge any MCP-originated nodes the server has appended to
      // snapshot.json since the last time this workflow was saved. Runs
      // after the initial `set()` so the canvas paints immediately; the
      // delta is merged in a follow-up tick and persisted back to IDB so
      // these nodes become part of the canonical graph.
      void (async () => {
        const existingIds = new Set(idbNodes.map((n) => n.id));
        const delta = await fetchMcpSnapshotDelta(rec.id, existingIds);
        if (!delta.length) return;
        // Re-check the active workflow — the user may have navigated away
        // while we were waiting on the network.
        if (get().activeWorkflowId !== rec.id) return;
        const { addNodes, _saveCurrentWorkflow } = get();
        addNodes(delta);
        await _saveCurrentWorkflow();
        console.info(
          `[wsu] merged ${delta.length} MCP node(s) into workflow ${rec.id}`,
        );
      })();

      return true;
    },

    _saveCurrentWorkflow: async () => {
      const { activeWorkflowId, activeWorkflowName, nodes, edges } = get();
      if (!activeWorkflowId) return;
      const strippedNodes = stripRuntimeFields(nodes) as unknown[];
      const record: WorkflowRecord = {
        id: activeWorkflowId,
        name: activeWorkflowName || "Untitled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data: {
          nodes: strippedNodes,
          edges: edges as unknown[],
        },
      };
      const existing = await getWorkflow(activeWorkflowId);
      if (existing) record.createdAt = existing.createdAt;
      await putWorkflow(record);
      // Mirror the graph to disk so the MCP server can serve it. Best-effort:
      // MCP is an opt-in surface; if the PUT fails (Next.js down, disk full,
      // CSRF tightened later) we still keep the IndexedDB copy, which is the
      // source of truth for the UI.
      void pushWorkflowSnapshot(record.id, record.name, strippedNodes, edges);
    },

    createWorkflow: async (name?: string) => {
      // Save current first
      const { activeWorkflowId, _saveCurrentWorkflow } = get();
      if (activeWorkflowId) await _saveCurrentWorkflow();

      const id = uid("wf");
      const now = Date.now();
      const record: WorkflowRecord = {
        id,
        name: name || "Untitled Workflow",
        createdAt: now,
        updatedAt: now,
        data: { nodes: [], edges: [] },
      };
      await putWorkflow(record);
      set({
        activeWorkflowId: id,
        activeWorkflowName: record.name,
        nodes: [],
        edges: [],
        selectedNodeId: null,
      });
      get()._clearHistory();
      _persistActiveId(id);
      return id;
    },

    deleteWorkflow: async (id: string) => {
      await deleteWorkflowRecord(id);
      if (get().activeWorkflowId === id) {
        set({ activeWorkflowId: null, activeWorkflowName: "", nodes: [], edges: [], selectedNodeId: null });
        get()._clearHistory();
        _persistActiveId(null);
      }
    },

    duplicateWorkflow: async (id: string) => {
      const newId = uid("wf");
      const src = await getWorkflow(id);
      if (!src) return null;
      await duplicateWorkflowRecord(id, newId, src.name + " (copy)");
      return newId;
    },

    renameWorkflow: async (id: string, name: string) => {
      const rec = await getWorkflow(id);
      if (!rec) return;
      rec.name = name;
      rec.updatedAt = Date.now();
      await putWorkflow(rec);
      if (get().activeWorkflowId === id) {
        set({ activeWorkflowName: name });
      }
    },

    goToDashboard: async () => {
      const { activeWorkflowId, _saveCurrentWorkflow } = get();
      if (activeWorkflowId) await _saveCurrentWorkflow();
      set({ activeWorkflowId: null, activeWorkflowName: "", nodes: [], edges: [], selectedNodeId: null });
      get()._clearHistory();
      _persistActiveId(null);
    },
  })
);

// ---------------------------------------------------------------------------
// Persist only `activeWorkflowId` to localStorage (tiny, no size issues).
// ---------------------------------------------------------------------------
const ACTIVE_WF_KEY = "wsu-active-workflow-id";

function _persistActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_WF_KEY, id);
    else localStorage.removeItem(ACTIVE_WF_KEY);
  } catch { /* ignore */ }
}

function _loadPersistedActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_WF_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Boot: migrate old single-workflow data + restore active workflow
// ---------------------------------------------------------------------------
const IDB_STORE_NAME = "wsu-kv";
const IDB_DB_NAME = "wsu-persist";

function _openLegacyIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(IDB_STORE_NAME)) {
        idb.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _getLegacyData(): Promise<{ nodes: unknown[]; edges: unknown[] } | null> {
  try {
    // Check localStorage first (oldest migration path)
    const ls = localStorage.getItem("wsu-workflow");
    if (ls) {
      const parsed = JSON.parse(ls);
      const state = parsed?.state;
      if (state?.nodes && state?.edges) {
        localStorage.removeItem("wsu-workflow");
        return { nodes: state.nodes, edges: state.edges };
      }
    }
  } catch { /* ignore */ }

  try {
    // Check old IDB KV store
    const idb = await _openLegacyIDB();
    const val: string | undefined = await new Promise((resolve, reject) => {
      const tx = idb.transaction(IDB_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.get("wsu-workflow");
      req.onsuccess = () => resolve(req.result as string | undefined);
      req.onerror = () => reject(req.error);
    });
    if (val) {
      const parsed = JSON.parse(val);
      const state = parsed?.state;
      if (state?.nodes && state?.edges) {
        // Remove old data
        const delTx = idb.transaction(IDB_STORE_NAME, "readwrite");
        delTx.objectStore(IDB_STORE_NAME).delete("wsu-workflow");
        return { nodes: state.nodes, edges: state.edges };
      }
    }
  } catch { /* ignore */ }

  return null;
}

async function _boot() {
  // 1. Migrate legacy single-workflow data if present
  const legacy = await _getLegacyData();
  if (legacy && Array.isArray(legacy.nodes) && legacy.nodes.length > 0) {
    const id = uid("wf");
    const now = Date.now();
    await putWorkflow({
      id,
      name: "Untitled Workflow",
      createdAt: now,
      updatedAt: now,
      data: { nodes: legacy.nodes, edges: legacy.edges },
    });
    console.log("[wsu] Migrated legacy workflow →", id);
    useWorkflowStore.setState({
      activeWorkflowId: id,
      activeWorkflowName: "Untitled Workflow",
      nodes: legacy.nodes as WSNode[],
      edges: legacy.edges as WSEdge[],
    });
    _persistActiveId(id);
    return;
  }

  // 2. Restore last active workflow
  const savedId = _loadPersistedActiveId();
  if (savedId) {
    const rec = await getWorkflow(savedId);
    if (rec) {
      useWorkflowStore.setState({
        activeWorkflowId: rec.id,
        activeWorkflowName: rec.name,
        nodes: migrateNodes((rec.data.nodes ?? []) as WSNode[]),
        edges: (rec.data.edges ?? []) as WSEdge[],
      });
      return;
    }
    _persistActiveId(null);
  }
}

if (typeof window !== "undefined") {
  void _boot();
}

// ---------------------------------------------------------------------------
// Frame helpers — exported as pure functions so components (FrameNode's
// "Export final video" button) can compute selections without subscribing to
// the whole nodes array on every change.
// ---------------------------------------------------------------------------

export interface FrameVideoChild {
  nodeId: string;
  /** URL the `/api/workflows/.../assets/...` route serves. */
  videoUrl: string;
  /** Computed ordering index — lower = earlier in the concat output. */
  order: number;
  /** Raw position used for sorting; kept for diagnostics only. */
  position: { x: number; y: number };
}

/**
 * Collect every `gen.video` child of the given frame that has a `videoUrl`,
 * sorted in the order they should be concatenated. Ordering is
 *   primary: row (y rounded to 80-px buckets so small alignment drift doesn't
 *            flip left/right ordering)
 *   secondary: x (left-to-right within a row)
 *
 * We deliberately bucket y so a horizontally-flowing "strip" of scenes reads
 * left-to-right even when the user hasn't snap-aligned them perfectly. Vertical
 * stacks still work because different rows still sort top-to-bottom.
 *
 * Returns `[]` when the frame has no videos yet or when any child is missing
 * a `videoUrl` — the caller decides whether to surface "not ready" to the UI.
 */
export function getFrameVideoChildren(frameId: string): FrameVideoChild[] {
  const nodes = useWorkflowStore.getState().nodes;
  const children: Array<{
    nodeId: string;
    videoUrl: string;
    x: number;
    y: number;
  }> = [];
  for (const n of nodes) {
    if (n.parentId !== frameId) continue;
    const d = n.data as NodeDataBase;
    if (d.kind !== "gen.video") continue;
    const url = d.videoHdUrl || d.videoUrl;
    if (!url || typeof url !== "string") continue;
    children.push({
      nodeId: n.id,
      videoUrl: url,
      x: n.position?.x ?? 0,
      y: n.position?.y ?? 0,
    });
  }
  // 80-pixel row bucket — big enough to tolerate manual drag drift, small
  // enough that rows of different grid lines stay separate. Tune if scenes
  // get laid out more densely.
  const ROW_BUCKET = 80;
  children.sort((a, b) => {
    const ra = Math.round(a.y / ROW_BUCKET);
    const rb = Math.round(b.y / ROW_BUCKET);
    if (ra !== rb) return ra - rb;
    return a.x - b.x;
  });
  return children.map((c, i) => ({
    nodeId: c.nodeId,
    videoUrl: c.videoUrl,
    order: i,
    position: { x: c.x, y: c.y },
  }));
}
