import type { Edge } from "@xyflow/react";

import type { NodeDataBase, NodeKind } from "@/lib/nodes";
import type { WSNode } from "@/state/workflowStore";

export interface BuildOpts {
  data?: Partial<NodeDataBase>;
}

export function node(id: string, kind: NodeKind, opts: BuildOpts = {}): WSNode {
  return {
    id,
    type: "wsNode",
    position: { x: 0, y: 0 },
    data: { kind, ...opts.data } as NodeDataBase,
  };
}

export function edge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

/**
 * Install nodes+edges into the Zustand store for tests. Uses the internal
 * setState — not exposed in the store public API but fine in test.
 */
export async function seedStore(nodes: WSNode[], edges: Edge[]) {
  const { useWorkflowStore } = await import("@/state/workflowStore");
  useWorkflowStore.setState({
    activeWorkflowId: "test",
    activeWorkflowName: "Test",
    nodes,
    edges,
    selectedNodeId: null,
  });
}
