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
 * Fire-and-forget pre-warm before a run. We do NOT await — the purpose is
 * to overlap the (possibly cold) collector init with the client-side graph
 * prep. The server dedupes in-flight calls, so repeated invocations are
 * cheap. If the cache is expired / stale, /api/auth/prewarm decides to
 * force a browser round-trip; otherwise it just primes the page handle.
 *
 * Providers are derived from the graph so we only warm what we'll actually
 * use — avoids needlessly opening Grok Chrome when the workflow is VEO-only.
 */
function prewarmProvidersForRun(providerIds: Set<"veo" | "grok">): void {
  const targets = Array.from(providerIds);
  if (!targets.length) return;
  if (typeof window === "undefined") return;
  try {
    void fetch("/api/auth/prewarm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets }),
    });
  } catch {
    // ignore — prewarm is purely an optimisation
  }
}

/**
 * Peek at a single node's provider without bringing in the whole
 * classifier import chain. Mirrors `providerOfNode` but cheap + local.
 */
function providerForNodeData(data: NodeDataBase): "veo" | "grok" | null {
  const kind = data.kind;
  const mode = data.genMode;
  if (kind === "gen.start-end") return "veo";
  if (kind === "xform.upscale.grok") return "grok";
  if (kind === "gen.image") return mode?.endsWith(".grok") ? "grok" : "veo";
  if (kind === "gen.video") return mode?.endsWith(".grok") ? "grok" : "veo";
  return null;
}

/**
 * Check whether an error message is a session/auth error. If so → push it to the
 * global store so `SessionErrorDialog` can show a popup asking the user to
 * re-login with the correct provider. Best-effort — silent if unknown.
 */
function reportIfSessionError(nodeId: string, message: string | undefined): void {
  if (!message) return;
  const node = useWorkflowStore.getState().nodes.find((n) => n.id === nodeId);
  const classified = classifySessionError(message, node?.data);
  if (!classified) return;
  useSessionErrorStore.getState().show({
    provider: classified.provider,
    kind: classified.kind,
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
/* (Legacy helper `runNodeWithDeps` was replaced by `runSingleNodeForce`      */
/* below — sequential topological re-run with forced parent output refresh.) */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Forced upstream re-run                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Collect every ancestor of `targetId` in topological order (root → target),
 * NOT including `targetId` itself. Cycles are avoided via a `visited` set.
 * Duplicates in the DAG are only emitted once.
 */
export function collectUpstreamOrder(targetId: string): string[] {
  const store = useWorkflowStore.getState();
  const parentsByTarget = new Map<string, string[]>();
  for (const e of store.edges) {
    const arr = parentsByTarget.get(e.target);
    if (arr) arr.push(e.source);
    else parentsByTarget.set(e.target, [e.source]);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = (nid: string) => {
    if (nid === targetId) {
      // Recurse into target's parents but don't include target in the output.
      for (const p of parentsByTarget.get(nid) ?? []) visit(p);
      return;
    }
    if (seen.has(nid) || visiting.has(nid)) return;
    visiting.add(nid);
    for (const p of parentsByTarget.get(nid) ?? []) visit(p);
    visiting.delete(nid);
    seen.add(nid);
    ordered.push(nid);
  };

  visit(targetId);
  return ordered;
}

/** Fields to clear before force-running a generation node. */
function clearGenOutput(nodeId: string): void {
  const store = useWorkflowStore.getState();
  store.updateNodeData(nodeId, {
    status: "idle",
    progress: 0,
    error: undefined,
    statusLog: undefined,
    outputs: undefined,
    imageUrl: undefined,
    imageMediaId: undefined,
    videoUrl: undefined,
    videoHdUrl: undefined,
  });
}

/**
 * Force re-run of every upstream node (in topological order) before running
 * `targetId`. Content nodes are skipped (text chains have their
 * `effectiveText` recomputed so a downstream gen node sees the latest prompt,
 * but no queued job is produced).
 *
 * Unlike `runNodeWithDeps`, this:
 *   - re-runs nodes that are already `done` (clears their output first),
 *   - runs STRICTLY sequentially (never `Promise.all`) so each downstream gen
 *     node sees the newest upstream output in the store before building its
 *     own inputs.
 */
async function runSingleNodeForce(targetId: string): Promise<void> {
  const upstream = collectUpstreamOrder(targetId);
  const total = upstream.length;

  for (let i = 0; i < total; i++) {
    const nid = upstream[i];
    const store = useWorkflowStore.getState();
    const node = store.nodes.find((n) => n.id === nid);
    if (!node) continue;

    if (node.data.kind === "content.text") {
      const combined = computeEffectiveText(nid);
      store.updateNodeData(nid, {
        effectiveText: combined,
        status: "done",
        progress: 100,
      });
      continue;
    }
    if (node.data.kind.startsWith("content.")) {
      store.updateNodeData(nid, { status: "done", progress: 100 });
      continue;
    }

    useWorkflowStore.getState().updateNodeData(targetId, {
      statusLog: `Upstream ${i + 1}/${total}: ${node.data.label || node.data.kind}…`,
    });
    clearGenOutput(nid);
    await runGenerationById(nid);
  }

  // Upstream done — clear the target's statusLog before running it.
  useWorkflowStore.getState().updateNodeData(targetId, { statusLog: undefined });

  // Expand the target's output-count clones (not upstream), then run them.
  const ids = expandCountToClones(targetId);
  for (const id of ids) {
    await runGenerationById(id);
  }
}

/**
 * Run a single node on user request.
 *
 * @param opts.cascade (default `false`):
 *   - `false` → run **only the current node**. If upstream gen nodes are not `done`
 *     and have no usable output → the server will throw "Image upstream required…" /
 *     "Video upstream required…" depending on the provider.
 *   - `true` → **forced sequential upstream re-run** via `runSingleNodeForce`:
 *     every upstream gen node is cleared and re-run in topological order, then
 *     the target runs. Content nodes are passed through without re-running.
 *
 * If the target has `outputCount > 1`, N-1 clones are expanded next to it
 * (upstream is not expanded). In non-cascade mode clones run in parallel; in
 * cascade mode they run one after another to preserve the "subsequent node
 * has data before running" invariant users asked for.
 */
export async function runSingleNode(
  nodeId: string,
  opts: { cascade?: boolean } = {},
): Promise<void> {
  const { cascade = false } = opts;
  const store = useWorkflowStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) return;

  // Prime the session for this node's provider (+ any upstream providers in
  // cascade mode) before we enqueue the job. Non-blocking — the server
  // dedupes and the 401 retry loop still catches real failures.
  const providers = new Set<"veo" | "grok">();
  const p = providerForNodeData(node.data);
  if (p) providers.add(p);
  if (cascade) {
    for (const up of collectUpstreamOrder(nodeId)) {
      const upNode = store.nodes.find((nn) => nn.id === up);
      if (!upNode) continue;
      const pp = providerForNodeData(upNode.data);
      if (pp) providers.add(pp);
    }
  }
  prewarmProvidersForRun(providers);

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

  if (cascade) {
    await runSingleNodeForce(nodeId);
    return;
  }

  const ids = expandCountToClones(nodeId);
  await Promise.all(ids.map((id) => runGenerationById(id)));
}

/* -------------------------------------------------------------------------- */
/* Run every node inside a Frame                                              */
/* -------------------------------------------------------------------------- */

/**
 * Run every node whose `parentId === frameId`. The run is **forced**:
 *
 *  - All non-content children are cleared first, regardless of whether they
 *    already carry an output. Even fully-`done` nodes are re-run so the user
 *    can be sure the entire Frame produced fresh artifacts.
 *  - Children execute with **per-provider lane scheduling**: each provider
 *    (VEO, Grok) has exactly 1 slot. Within a lane nodes run sequentially,
 *    with `gen.image` prioritised before `gen.video` / `gen.start-end`.
 *    Cross-provider parallelism is maintained — a Grok video can start
 *    as soon as its upstream VEO image finishes, without waiting for other
 *    VEO nodes in the lane queue.
 *  - Topological order is enforced: a gen node never starts before all its
 *    internal upstream nodes have finished, so downstream gen.video still
 *    sees the freshly-generated gen.image it depends on.
 *  - Edges crossing the Frame boundary don't change the order — the external
 *    node is assumed to already have its output in the store (or it's the
 *    user's responsibility to run it via the cascade button on a child).
 *
 * Live progress is mirrored onto the Frame's own node data
 * (`frameRunning`, `frameRunIndex`, `frameRunTotal`, `frameRunCurrentLabel`)
 * so `FrameNode` can render a counter.
 */
export async function runFrame(frameId: string): Promise<void> {
  const store = useWorkflowStore.getState();
  const children = store.nodes.filter((n) => n.parentId === frameId);
  if (!children.length) return;

  // Warm every provider the frame is about to touch. Much cheaper than
  // letting the first gen node eat the cold-start penalty.
  const providers = new Set<"veo" | "grok">();
  for (const child of children) {
    const p = providerForNodeData(child.data);
    if (p) providers.add(p);
  }
  prewarmProvidersForRun(providers);

  // Expand outputCount>1 clones so each gen lane runs its own job. Clones
  // inherit `parentId`, so they're picked up by the next store read.
  for (const child of children) {
    if (child.data.kind.startsWith("content.") || child.data.kind === "frame") continue;
    expandCountToClones(child.id);
  }

  const freshStore = useWorkflowStore.getState();
  const frameChildren = freshStore.nodes.filter((n) => n.parentId === frameId);
  const idSet = new Set(frameChildren.map((n) => n.id));
  const nodeById = new Map(frameChildren.map((n) => [n.id, n]));

  // Build local adjacency (only edges whose endpoints are both in the frame).
  // `indegree` is mutable during the run so children can be popped into the
  // ready queue as their parents finish.
  const indegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of idSet) {
    indegree.set(id, 0);
    adj.set(id, []);
  }
  for (const e of freshStore.edges) {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adj.get(e.source)?.push(e.target);
      indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    }
  }

  // Force re-run: clear outputs on every non-content child up-front so the
  // visual state matches the "running" intent and downstream nodes don't pick
  // up stale data while waiting for their turn.
  for (const id of idSet) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (node.data.kind.startsWith("content.") || node.data.kind === "frame") continue;
    clearGenOutput(id);
  }

  // Count gen nodes (content + frames don't count toward the X/Y counter the
  // user sees) so the progress label is meaningful.
  let totalGens = 0;
  for (const id of idSet) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (node.data.kind.startsWith("content.") || node.data.kind === "frame") continue;
    totalGens++;
  }

  useWorkflowStore.getState().updateNodeData(frameId, {
    frameRunning: true,
    frameRunIndex: 0,
    frameRunTotal: totalGens,
    frameRunCurrentLabel: undefined,
  });

  // Seed ready queue with indegree-0 nodes — content ones are drained
  // synchronously below, gen ones are dispatched by the scheduler.
  const ready: string[] = [];
  for (const [id, d] of indegree) if (d === 0) ready.push(id);

  const pending = new Set(idSet);
  let completedGens = 0;
  // Track currently running gen ids for the counter label. Using a Map
  // instead of a Set so we can pick the "most recent" label deterministically
  // by insertion order.
  const activeLabels = new Map<string, string>();

  // Per-provider lane state: each provider runs at most 1 gen node at a time.
  // Nodes without a provider (null) dispatch immediately with no lane check.
  const laneOccupied = new Map<string, boolean>();
  laneOccupied.set("veo", false);
  laneOccupied.set("grok", false);

  const markReadyChildren = (parentId: string) => {
    for (const ch of adj.get(parentId) ?? []) {
      const next = (indegree.get(ch) ?? 0) - 1;
      indegree.set(ch, next);
      if (next === 0) ready.push(ch);
    }
  };

  const settleContentNow = (id: string) => {
    const node = nodeById.get(id);
    if (!node) return;
    if (node.data.kind === "content.text") {
      const combined = computeEffectiveText(id);
      useWorkflowStore.getState().updateNodeData(id, {
        effectiveText: combined,
        status: "done",
        progress: 100,
      });
    } else if (node.data.kind.startsWith("content.")) {
      useWorkflowStore.getState().updateNodeData(id, { status: "done", progress: 100 });
    }
    pending.delete(id);
    markReadyChildren(id);
  };

  const updateCounter = () => {
    let label: string | undefined;
    if (activeLabels.size > 0) {
      const last = Array.from(activeLabels.values()).pop();
      label = activeLabels.size > 1
        ? `${activeLabels.size} đang chạy · ${last}`
        : last;
    }
    useWorkflowStore.getState().updateNodeData(frameId, {
      frameRunIndex: completedGens,
      frameRunCurrentLabel: label,
    });
  };

  // Priority: gen.image < gen.video / gen.start-end so images run first
  // within the same provider lane.
  const kindPriority = (kind: string): number => {
    if (kind === "gen.image") return 0;
    return 1; // gen.video, gen.start-end, etc.
  };

  try {
    await new Promise<void>((resolveAll) => {
      let inFlight = 0;

      const tryDispatch = () => {
        // Drain content/frame nodes synchronously in every pass — they never
        // enqueue a job but their "done" status might unblock a gen child.
        for (let i = 0; i < ready.length;) {
          const id = ready[i];
          const node = nodeById.get(id);
          if (!node) {
            ready.splice(i, 1);
            pending.delete(id);
            continue;
          }
          if (node.data.kind === "frame") {
            ready.splice(i, 1);
            pending.delete(id);
            markReadyChildren(id);
            continue;
          }
          if (node.data.kind.startsWith("content.")) {
            ready.splice(i, 1);
            settleContentNow(id);
            continue;
          }
          i++;
        }

        // Sort ready gen nodes: image before video (within same provider).
        ready.sort((a, b) => {
          const na = nodeById.get(a);
          const nb = nodeById.get(b);
          if (!na || !nb) return 0;
          return kindPriority(na.data.kind) - kindPriority(nb.data.kind);
        });

        // Dispatch at most one node per free provider lane.
        // Track which lanes we've already dispatched to in this pass so we
        // don't double-dispatch when two ready nodes share a provider.
        const dispatchedLanes = new Set<string>();

        for (let i = 0; i < ready.length;) {
          const id = ready[i];
          const node = nodeById.get(id);
          if (!node) {
            ready.splice(i, 1);
            continue;
          }

          const provider = providerForNodeData(node.data); // "veo" | "grok" | null

          // Lane check: if this provider lane is occupied → skip
          if (provider && (laneOccupied.get(provider) || dispatchedLanes.has(provider))) {
            i++;
            continue;
          }

          // Dispatch this node
          ready.splice(i, 1);
          if (provider) {
            laneOccupied.set(provider, true);
            dispatchedLanes.add(provider);
          }

          inFlight++;
          const label = node.data.label || node.data.kind;
          activeLabels.set(id, label);
          updateCounter();

          // Post-generation "browse pause" range for VEO nodes (ms). Simulates
          // a human user reviewing the result before starting the next gen.
          // Combined with the server-side 30s throttle, this creates ~35-47s
          // total gap between VEO requests — much closer to natural pacing.
          const POST_GEN_PAUSE_MIN = 5_000;
          const POST_GEN_PAUSE_MAX = 12_000;

          const runWithPause = async () => {
            try {
              await runGenerationById(id);
            } catch (err) {
              console.error(`[runFrame] ${id} threw:`, err);
            }

            // Post-gen pause: keep the lane occupied a bit longer so the
            // next VEO request doesn't fire immediately after this one.
            // Only for VEO — Grok uses its own Chrome session and doesn't
            // have reCAPTCHA scoring concerns.
            if (provider === "veo" && pending.size > 0) {
              const pause = POST_GEN_PAUSE_MIN +
                Math.floor(Math.random() * (POST_GEN_PAUSE_MAX - POST_GEN_PAUSE_MIN));
              const node2 = nodeById.get(id);
              const lbl = node2?.data.label || node2?.data.kind || id;
              useWorkflowStore.getState().updateNodeData(frameId, {
                frameRunCurrentLabel: `Đợi ${(pause / 1000).toFixed(0)}s sau ${lbl}…`,
              });
              await new Promise((r) => setTimeout(r, pause));
            }

            inFlight--;
            completedGens++;
            if (provider) laneOccupied.set(provider, false);
            activeLabels.delete(id);
            pending.delete(id);
            markReadyChildren(id);
            updateCounter();
            if (pending.size === 0 && inFlight === 0) {
              resolveAll();
              return;
            }
            tryDispatch();
          };

          void runWithPause();
        }

        // Nothing left to do: scheduler can resolve.
        if (pending.size === 0 && inFlight === 0) {
          resolveAll();
        }
      };

      tryDispatch();
      // Edge case: no gen nodes at all (pure content frame).
      if (pending.size === 0 && inFlight === 0) resolveAll();
    });
  } finally {
    useWorkflowStore.getState().updateNodeData(frameId, {
      frameRunning: false,
      frameRunIndex: undefined,
      frameRunTotal: undefined,
      frameRunCurrentLabel: undefined,
    });
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

  // Warm every provider the workflow will touch so the first job doesn't
  // have to wait for collectAuth / statsig capture.
  const providers = new Set<"veo" | "grok">();
  for (const n of nodes) {
    const p = providerForNodeData(n.data);
    if (p) providers.add(p);
  }
  prewarmProvidersForRun(providers);

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
