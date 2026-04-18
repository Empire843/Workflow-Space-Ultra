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

import { NODE_CATALOG, type NodeDataBase, type NodeKind } from "@/lib/nodes";
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
  showPalette: boolean;
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
  cloneNode: (sourceId: string, offsetIndex: number, extra?: Partial<NodeDataBase>) => WSNode | null;
  updateNodeData: (id: string, data: Partial<NodeDataBase>) => void;
  removeNode: (id: string) => void;
  selectNode: (id: string | null) => void;

  setCanvasTool: (tool: CanvasTool) => void;
  togglePalette: () => void;
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
    showPalette: true,
    showMinimap: true,

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
    togglePalette: () => set((s) => ({ showPalette: !s.showPalette })),
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
      const node: WSNode = {
        id,
        type: "wsNode",
        position,
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

    cloneNode: (sourceId, offsetIndex, extra) => {
      const src = get().nodes.find((n) => n.id === sourceId);
      if (!src) return null;
      get()._takeSnapshot();
      const id = uid("node");
      const pos = {
        x: (src.position.x || 0) + 280 * offsetIndex,
        y: (src.position.y || 0) + (offsetIndex % 2 === 0 ? 0 : 30),
      };
      const cloned: WSNode = {
        id,
        type: "wsNode",
        position: pos,
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
      set({
        nodes: get().nodes.filter((n) => n.id !== id),
        edges: get().edges.filter((e) => e.source !== id && e.target !== id),
        selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
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
      for (const c of changes) {
        if (c.type === "position") {
          if (c.dragging) dragStart = true;
          else dragEnd = true;
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

      const nextNodes = applyNodeChanges(changes, get().nodes) as WSNode[];
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
      set({
        activeWorkflowId: rec.id,
        activeWorkflowName: rec.name,
        nodes: (rec.data.nodes ?? []) as WSNode[],
        edges: (rec.data.edges ?? []) as WSEdge[],
        selectedNodeId: null,
      });
      get()._clearHistory();
      _persistActiveId(rec.id);
      return true;
    },

    _saveCurrentWorkflow: async () => {
      const { activeWorkflowId, activeWorkflowName, nodes, edges } = get();
      if (!activeWorkflowId) return;
      const record: WorkflowRecord = {
        id: activeWorkflowId,
        name: activeWorkflowName || "Untitled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data: {
          nodes: stripRuntimeFields(nodes) as unknown[],
          edges: edges as unknown[],
        },
      };
      const existing = await getWorkflow(activeWorkflowId);
      if (existing) record.createdAt = existing.createdAt;
      await putWorkflow(record);
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
        nodes: (rec.data.nodes ?? []) as WSNode[],
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
