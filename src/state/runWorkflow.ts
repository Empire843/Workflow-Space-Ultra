"use client";

import type { Edge } from "@xyflow/react";

import type { NodeDataBase } from "@/lib/nodes";
import { joinTextSegments } from "@/lib/prompt";
import { classifySessionError } from "@/lib/sessionError";
import { uid } from "@/lib/utils";
import { getEdgesByTarget, getNodesById } from "@/state/graphMaps";
import { useSessionErrorStore } from "@/state/sessionErrorStore";
import { useWorkflowStore } from "@/state/workflowStore";

/**
 * Check whether an error message is a session/auth error. If so → push it to the
 * global store so `SessionErrorDialog` can show a popup asking the user to
 * re-login with the correct provider. Best-effort — silent if unknown.
 */
function reportIfSessionError(nodeId: string, message: string | undefined): void {
  if (!message) return;
  const node = useWorkflowStore.getState().nodes.find((n) => n.id === nodeId);
  const provider = classifySessionError(message, node?.data);
  if (!provider) return;
  useSessionErrorStore.getState().show({
    provider,
    message,
    nodeId,
    nodeLabel: node?.data.label || node?.data.kind,
  });
}

/**
 * Executor helpers:
 *  - runWorkflow(): topologically run every node
 *  - runSingleNode(nodeId): run just one node using the upstream outputs already
 *    in the store (reports an error if upstream isn't done).
 */

interface JobStreamMsg {
  type: string;
  status?: string;
  progress?: number;
  output?: NodeDataBase;
  error?: string;
  log?: string;
  job?: { status: string; progress: number };
}

async function enqueueAndWait(
  nodeId: string,
  kind: string,
  data: NodeDataBase,
  inputs: NodeDataBase[],
  onUpdate: (patch: Partial<NodeDataBase>) => void
): Promise<NodeDataBase | null> {
  onUpdate({ status: "queued", progress: 0, error: undefined, jobId: undefined });

  // Pass the active workflow id so the server can park generated media under
  // `Workflows/<id>/assets/` — keeps previews working across account switches
  // and makes clean-up per workflow trivial. Ad-hoc runs without an open
  // workflow still work; the server just falls back to the flat downloads/ dir.
  const workflowRunId = useWorkflowStore.getState().activeWorkflowId || undefined;

  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, kind, data, inputs, workflowRunId }),
  });
  const json = (await res.json()) as { ok: boolean; jobId?: string; message?: string };
  if (!json.ok || !json.jobId) {
    const errMsg = json.message || "Enqueue failed";
    onUpdate({ status: "error", error: errMsg });
    reportIfSessionError(nodeId, errMsg);
    return null;
  }

  const jobId = json.jobId;
  onUpdate({ jobId });

  /**
   * SSE is our primary channel; HTTP polling is a safety net.
   *
   * Failure modes we now handle:
   *  1. The server restarts mid-job (HMR / crash): SSE drops, the job no longer
   *     exists → we poll /api/jobs/:id, see 404, mark the node as "error" instead
   *     of leaving it yellow forever.
   *  2. The SSE controller crashes (legacy "ERR_INVALID_STATE"): same as above.
   *  3. Network blip: EventSource auto-reconnects; polling fills any gap.
   */
  return new Promise<NodeDataBase | null>((resolve) => {
    let finalOutput: NodeDataBase | null = null;
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (output: NodeDataBase | null) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      try { es.close(); } catch { /* ignore */ }
      onUpdate({ jobId: undefined });
      resolve(output);
    };

    const applyMsg = (msg: JobStreamMsg) => {
      if (msg.type === "snapshot" && msg.job) {
        onUpdate({ status: msg.job.status as NodeDataBase["status"], progress: msg.job.progress });
      } else if (msg.type === "progress" && typeof msg.progress === "number") {
        onUpdate({ progress: msg.progress });
      } else if (msg.type === "status" && msg.status) {
        if (msg.status === "queued") onUpdate({ status: "queued" });
        if (msg.status === "running") onUpdate({ status: "running", progress: 1 });
        if (msg.status === "cancelled") onUpdate({ status: "error", error: "Cancelled" });
      } else if (msg.type === "output" && msg.output) {
        // Split overflow items into clone nodes before updating the original node
        if (msg.output.outputsOverflow?.length) {
          const overflow = msg.output.outputsOverflow;
          const store = useWorkflowStore.getState();
          for (let i = 0; i < overflow.length; i++) {
            const ov = overflow[i];
            store.cloneNode(nodeId, i + 1, {
              outputCount: 1,
              outputs: [ov],
              imageUrl: ov.imageUrl,
              imageMediaId: ov.imageMediaId,
              videoUrl: ov.videoUrl,
              videoHdUrl: ov.videoHdUrl,
              status: "done",
              progress: 100,
            });
          }
          delete msg.output.outputsOverflow;
        }
        finalOutput = msg.output;
        onUpdate({ ...msg.output, status: "done", progress: 100, statusLog: undefined });
      } else if (msg.type === "error" && msg.error) {
        onUpdate({ status: "error", error: msg.error });
        reportIfSessionError(nodeId, msg.error);
      } else if (msg.type === "log" && msg.log) {
        onUpdate({ statusLog: msg.log });
      }
      if (msg.type === "status" && (msg.status === "done" || msg.status === "error" || msg.status === "cancelled")) {
        finish(finalOutput);
      }
    };

    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        applyMsg(JSON.parse(ev.data) as JobStreamMsg);
      } catch {
        // ignore parse errors
      }
    };
    es.onerror = () => {
      // Don't immediately fail the node — the browser auto-reconnects EventSource
      // for transient network issues. The polling loop below is the authoritative
      // fallback that decides when to give up.
    };

    // Polling safety net: every 4s, ask the server for the job's current state.
    // If the server doesn't know about the job (404) → server restarted, treat as
    // error. If the job is in a terminal state → honor that and finish.
    pollTimer = setInterval(async () => {
      if (settled) return;
      try {
        const r = await fetch(`/api/jobs/${jobId}`);
        if (r.status === 404) {
          onUpdate({ status: "error", error: "Server forgot this job (restarted?)" });
          finish(null);
          return;
        }
        const body = (await r.json()) as {
          ok: boolean;
          job?: { status: string; progress: number; error?: string; output?: NodeDataBase };
        };
        if (!body.ok || !body.job) return;
        const j = body.job;
        if (j.status === "done" && j.output) {
          finalOutput = j.output;
          onUpdate({ ...j.output, status: "done", progress: 100, statusLog: undefined });
          finish(finalOutput);
        } else if (j.status === "error") {
          onUpdate({ status: "error", error: j.error || "Job failed" });
          finish(null);
        } else if (j.status === "cancelled") {
          onUpdate({ status: "error", error: "Cancelled" });
          finish(null);
        }
      } catch {
        // network error — keep trying
      }
    }, 4000);
  });
}

/**
 * Recursively resolve a chain of text nodes: returns the concatenation of all upstream
 * text nodes (depth-first, in edge array order) plus this node's own text.
 *
 * - Only traverses `content.text` nodes (other kinds don't participate in the chain).
 * - The `visited` Set prevents infinite recursion on graphs with cycles.
 * - Used by:
 *     + runSingleNode when the user directly runs the last text node in a chain
 *     + runGenerationById when preparing the prompt for a gen node
 *     + a Zustand selector for live UI preview
 *
 * Does NOT mutate the store. Callers may call updateNodeData to cache the result.
 */
function computeEffectiveText(nodeId: string, visited: Set<string> = new Set()): string {
  if (visited.has(nodeId)) return "";
  visited.add(nodeId);

  const store = useWorkflowStore.getState();
  const node = getNodesById(store.nodes).get(nodeId);
  if (!node || node.data.kind !== "content.text") return "";

  const parentEdges = getEdgesByTarget(store.edges).get(nodeId) ?? [];
  const upstream = parentEdges.map((e) => computeEffectiveText(e.source, visited));
  return joinTextSegments([...upstream, node.data.text]);
}

/**
 * Exported so UI components (WSNode) can use it via a Zustand selector for live preview.
 */
export { computeEffectiveText };

/**
 * Generation node kinds that support `outputCount` in the UI.
 * VEO nodes allow a count of 1–4; Grok currently doesn't.
 */
const COUNT_EXPANDABLE_KINDS = new Set([
  "gen.image",
  "gen.video",
  "gen.start-end",
]);

/**
 * If a node has `outputCount >= 2` → create N-1 clone nodes next to it (same config,
 * different seed), copying the original's input edges. Set `outputCount=1` on both
 * the original and clones. Returns the list of ids to run (original first, then clones).
 *
 * If outputCount <= 1 or the kind is not supported → returns [nodeId] without mutating.
 */
function expandCountToClones(nodeId: string): string[] {
  const store = useWorkflowStore.getState();
  const src = store.nodes.find((n) => n.id === nodeId);
  if (!src) return [];
  const count = Math.max(1, Math.min(4, Number(src.data.outputCount) || 1));
  if (count <= 1 || !COUNT_EXPANDABLE_KINDS.has(src.data.kind)) {
    return [nodeId];
  }

  const srcInputEdges = store.edges.filter((e) => e.target === nodeId);
  const ids: string[] = [nodeId];

  // Reset the original's count to 1 so the server payload doesn't multi-gen again
  store.updateNodeData(nodeId, { outputCount: 1 });

  for (let i = 1; i < count; i++) {
    const cloned = store.cloneNode(nodeId, i, {
      outputCount: 1,
      seed: typeof src.data.seed === "number"
        ? (src.data.seed + i) % 294967296
        : Math.floor(Math.random() * 294967296),
      label: src.data.label ? `${src.data.label} #${i + 1}` : undefined,
    });
    if (!cloned) continue;
    // Copy input edges: each upstream → clone
    const clonedEdges: Edge[] = srcInputEdges.map((e) => ({
      id: uid("edge"),
      source: e.source,
      target: cloned.id,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      animated: true,
      style: { stroke: "#ff3c8e" },
    }));
    if (clonedEdges.length) {
      store.addEdges(clonedEdges);
    }
    ids.push(cloned.id);
  }
  return ids;
}

/**
 * Run a single node. Upstream outputs are read from store.nodes[*].data.
 * If an upstream is a content node (always done) or already has status=done → use it as input.
 * If an upstream needs to run but isn't done → report an error.
 *
 * If the node has outputCount > 1 → expand into clone nodes and run them in parallel.
 */
async function runGenerationById(targetId: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = store.nodes.find((n) => n.id === targetId);
  if (!node) return;

  const update = (patch: Partial<NodeDataBase>) => store.updateNodeData(targetId, patch);

  const parentIds = store.edges
    .filter((e) => e.target === targetId)
    .map((e) => e.source);

  // Always recompute effectiveText for every content.text parent before building
  // inputs. This ensures a chain A→B→C→D has the correct prompt even if the user
  // hasn't hit run on each node in the chain.
  for (const pid of parentIds) {
    const p = store.nodes.find((n) => n.id === pid);
    if (p?.data.kind === "content.text") {
      const eff = computeEffectiveText(pid);
      store.updateNodeData(pid, { effectiveText: eff });
    }
  }

  // Re-read the store after updateNodeData so inputs reflect the new effectiveText.
  //
  // Cascading upstream auto-run (Phase 7f): the caller (`runSingleNode` →
  // `runNodeWithDeps`) ensures every parent has been run before calling this
  // function, so the "upstream has no output" guard is no longer needed → if data
  // is still missing, enqueue as usual and let the provider return a specific error
  // (e.g. "Image upstream required").
  const freshStore = useWorkflowStore.getState();
  const inputs: NodeDataBase[] = [];
  for (const pid of parentIds) {
    const p = freshStore.nodes.find((n) => n.id === pid);
    if (!p) continue;
    inputs.push(p.data);
  }

  await enqueueAndWait(targetId, node.data.kind, node.data, inputs, update);
}

/* -------------------------------------------------------------------------- */
/* Cascading upstream auto-run                                                */
/* -------------------------------------------------------------------------- */

/**
 * In-flight Promise cache: if two children both call `runNodeWithDeps(parent)`,
 * ensures the parent runs only once. Cleared after the Promise settles so the
 * next time the user hits Run, the cascade is fresh.
 */
const depRunCache = new Map<string, Promise<void>>();

/** Whether the node already has an output usable for downstream consumers. */
function hasUsableOutput(d: NodeDataBase): boolean {
  return Boolean(
    d.imageUrl ||
      d.videoUrl ||
      d.imageMediaId ||
      d.uploadBase64 ||
      (d.outputs && d.outputs.length > 0),
  );
}

/**
 * Run a single node after recursively resolving any upstream that isn't done.
 *
 * - Content nodes (text/upload/image/video): pass-through (or recompute
 *   effectiveText for a text chain).
 * - Gen nodes already `done` with a usable output → reuse, skip.
 * - Everything else (idle/error/running without cache): recurse into parents first,
 *   then run via `runGenerationById`.
 * - The `ancestors` Set prevents cycles.
 */
async function runNodeWithDeps(
  nodeId: string,
  ancestors: Set<string> = new Set(),
): Promise<void> {
  if (ancestors.has(nodeId)) return;
  const cached = depRunCache.get(nodeId);
  if (cached) return cached;

  const ancestorsNext = new Set(ancestors).add(nodeId);
  const p = _runNodeWithDeps(nodeId, ancestorsNext);
  depRunCache.set(nodeId, p);
  try {
    await p;
  } finally {
    depRunCache.delete(nodeId);
  }
}

async function _runNodeWithDeps(nodeId: string, ancestors: Set<string>): Promise<void> {
  const store = useWorkflowStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const parentIds = store.edges.filter((e) => e.target === nodeId).map((e) => e.source);

  // Resolve each parent in parallel. For each parent: recurse if it needs running,
  // skip if it's already ready. Before recursing, set statusLog on the current
  // TARGET so the user sees "Đợi upstream X…" inside the Picsart-style node.
  await Promise.all(
    parentIds.map(async (pid) => {
      const p = useWorkflowStore.getState().nodes.find((n) => n.id === pid);
      if (!p) return;
      const d = p.data;
      if (d.kind.startsWith("content.")) {
        if (d.kind === "content.text") {
          useWorkflowStore
            .getState()
            .updateNodeData(pid, { effectiveText: computeEffectiveText(pid) });
        }
        return;
      }
      if (d.status === "done" && hasUsableOutput(d)) return;

      useWorkflowStore.getState().updateNodeData(nodeId, {
        statusLog: `Đợi upstream "${d.label || d.kind}"…`,
      });
      await runNodeWithDeps(pid, ancestors);
    }),
  );

  // All parents are ready → run this node
  const fresh = useWorkflowStore.getState().nodes.find((n) => n.id === nodeId);
  if (!fresh) return;

  if (fresh.data.kind === "content.text") {
    const combined = computeEffectiveText(nodeId);
    useWorkflowStore.getState().updateNodeData(nodeId, {
      effectiveText: combined,
      status: "done",
      progress: 100,
    });
    return;
  }
  if (fresh.data.kind.startsWith("content.")) {
    useWorkflowStore
      .getState()
      .updateNodeData(nodeId, { status: "done", progress: 100 });
    return;
  }

  await runGenerationById(nodeId);
}

/**
 * Run a single node on user request.
 *
 * @param opts.cascade (default `false`):
 *   - `false` → run **only the current node**. If upstream gen nodes are not `done`
 *     and have no usable output → the server will throw "Image upstream required…" /
 *     "Video upstream required…" depending on the provider. The user must run upstream
 *     first or press the Run-with-upstream button.
 *   - `true` → cascade upstream auto-run: recurse via `runNodeWithDeps` to run every
 *     upstream that isn't ready, then enqueue the target. Parents already `done`
 *     with an output → reused, not re-run (Phase 7f logic).
 *
 * In both modes, if the target has `outputCount > 1`, N-1 clones are expanded next to
 * it (upstream is not expanded). Clones run in parallel.
 */
export async function runSingleNode(
  nodeId: string,
  opts: { cascade?: boolean } = {},
): Promise<void> {
  const { cascade = false } = opts;
  const store = useWorkflowStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  const update = (patch: Partial<NodeDataBase>) => store.updateNodeData(nodeId, patch);

  if (node.data.kind === "content.text") {
    const combined = computeEffectiveText(nodeId);
    update({ effectiveText: combined, status: "done", progress: 100 });
    return;
  }
  if (node.data.kind.startsWith("content.")) {
    update({ status: "done", progress: 100 });
    return;
  }

  const ids = expandCountToClones(nodeId);
  if (cascade) {
    await Promise.all(ids.map((id) => runNodeWithDeps(id)));
  } else {
    await Promise.all(ids.map((id) => runGenerationById(id)));
  }
}

export async function runWorkflow(opts?: { maxInFlight?: number }): Promise<void> {
  // Expand every generation node with outputCount > 1 before building the graph.
  // Snapshot ids first to avoid expanding newly-spawned clones (clones have outputCount=1).
  const preIds = useWorkflowStore.getState().nodes.map((n) => n.id);
  for (const id of preIds) {
    expandCountToClones(id);
  }

  // Re-read from the store after clones have been added
  const store = useWorkflowStore.getState();
  const nodes = store.nodes;
  const edges = store.edges;
  if (!nodes.length) return;

  const update = store.updateNodeData;

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    indegree.set(n.id, 0);
    children.set(n.id, []);
    parents.set(n.id, []);
  }
  for (const e of edges) {
    children.get(e.source)?.push(e.target);
    parents.get(e.target)?.push(e.source);
    indegree.set(e.target, (indegree.get(e.target) || 0) + 1);
  }

  const outputs = new Map<string, NodeDataBase>();
  const pending = new Set(nodes.map((n) => n.id));
  const ready: string[] = [];
  for (const [id, d] of indegree) if (d === 0) ready.push(id);

  const maxInFlight = opts?.maxInFlight ?? 3;
  let inFlight = 0;

  // Reset runtime status
  for (const n of nodes) {
    update(n.id, { status: "idle", progress: 0, error: undefined });
  }

  return new Promise<void>((resolveAll) => {
    const tryRun = () => {
      while (ready.length && inFlight < maxInFlight) {
        const id = ready.shift()!;
        runOne(id).catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          update(id, { status: "error", error: errMsg });
          reportIfSessionError(id, errMsg);
        });
      }
      if (!pending.size && inFlight === 0) resolveAll();
    };

    const runOne = async (id: string) => {
      inFlight++;
      pending.delete(id);
      const node = nodeById.get(id)!;
      const parentIds = parents.get(id) || [];
      const inputs = parentIds
        .map((pid) => outputs.get(pid))
        .filter((x): x is NodeDataBase => Boolean(x));

      if (node.data.kind.startsWith("content.")) {
        let outData: NodeDataBase = { ...node.data, status: "done", progress: 100 };
        if (node.data.kind === "content.text") {
          // Use the recursive helper for consistency with runSingleNode; the helper reads
          // from store.nodes directly and does not depend on the topo loop's `outputs` map.
          const combined = computeEffectiveText(id);
          outData = { ...outData, effectiveText: combined };
          update(id, { effectiveText: combined, status: "done", progress: 100 });
        } else {
          update(id, { status: "done", progress: 100 });
        }
        outputs.set(id, outData);
        finish(id);
        return;
      }

      const result = await enqueueAndWait(
        id,
        node.data.kind,
        node.data,
        inputs,
        (patch) => update(id, patch)
      );
      if (result) outputs.set(id, result);
      finish(id, !result);
    };

    const finish = (id: string, errored = false) => {
      inFlight--;
      if (!errored) {
        for (const c of children.get(id) || []) {
          indegree.set(c, (indegree.get(c) || 0) - 1);
          if (indegree.get(c) === 0) ready.push(c);
        }
      }
      tryRun();
      if (!pending.size && inFlight === 0) resolveAll();
    };

    tryRun();
    if (!pending.size && inFlight === 0) resolveAll();
  });
}
