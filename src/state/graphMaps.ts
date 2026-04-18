/**
 * Derived graph maps (nodesById, edgesByTarget). Computed lazily and memoized
 * against the identity of the input arrays via WeakMap — so as long as the
 * store's nodes/edges arrays are only replaced when the graph actually changes,
 * lookups amortize to O(1) regardless of how many React components call in.
 */

import type { Edge } from "@xyflow/react";

import type { WSNode } from "./workflowStore";

interface GraphMaps {
  nodesById: Map<string, WSNode>;
  edgesByTarget: Map<string, Edge[]>;
  edgesBySource: Map<string, Edge[]>;
}

const nodesCache = new WeakMap<WSNode[], Map<string, WSNode>>();
const edgesByTargetCache = new WeakMap<Edge[], Map<string, Edge[]>>();
const edgesBySourceCache = new WeakMap<Edge[], Map<string, Edge[]>>();

export function getNodesById(nodes: WSNode[]): Map<string, WSNode> {
  let m = nodesCache.get(nodes);
  if (!m) {
    m = new Map(nodes.map((n) => [n.id, n] as const));
    nodesCache.set(nodes, m);
  }
  return m;
}

export function getEdgesByTarget(edges: Edge[]): Map<string, Edge[]> {
  let m = edgesByTargetCache.get(edges);
  if (!m) {
    m = new Map();
    for (const e of edges) {
      const arr = m.get(e.target);
      if (arr) arr.push(e);
      else m.set(e.target, [e]);
    }
    edgesByTargetCache.set(edges, m);
  }
  return m;
}

export function getEdgesBySource(edges: Edge[]): Map<string, Edge[]> {
  let m = edgesBySourceCache.get(edges);
  if (!m) {
    m = new Map();
    for (const e of edges) {
      const arr = m.get(e.source);
      if (arr) arr.push(e);
      else m.set(e.source, [e]);
    }
    edgesBySourceCache.set(edges, m);
  }
  return m;
}

export function getGraphMaps(nodes: WSNode[], edges: Edge[]): GraphMaps {
  return {
    nodesById: getNodesById(nodes),
    edgesByTarget: getEdgesByTarget(edges),
    edgesBySource: getEdgesBySource(edges),
  };
}
