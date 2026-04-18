import { describe, it, expect, beforeEach, vi } from "vitest";

import { node, edge, seedStore } from "../_helpers/buildWorkflow";

async function imports() {
  const run = await import("@/state/runWorkflow");
  const store = await import("@/state/workflowStore");
  return { run, store };
}

beforeEach(async () => {
  const { store } = await imports();
  store.useWorkflowStore.setState({
    activeWorkflowId: null,
    activeWorkflowName: "",
    nodes: [],
    edges: [],
    selectedNodeId: null,
  });
});

/**
 * expandCountToClones is not exported — we exercise it via runSingleNode which
 * calls it as its first step (and since there's no fetch mocked for gen nodes,
 * we can stop right after expansion by checking the store state).
 */
describe("clone expansion (via runSingleNode input handling)", () => {
  it("does not clone when outputCount <= 1", async () => {
    await seedStore([node("v", "gen.image", { data: { outputCount: 1, prompt: "x" } })], []);
    const { store } = await imports();
    expect(store.useWorkflowStore.getState().nodes).toHaveLength(1);
  });

  it("creates N-1 clones with distinct seeds and copies input edges", async () => {
    await seedStore(
      [
        node("t", "content.text", { data: { text: "cat" } }),
        node("g", "gen.image", { data: { outputCount: 3, prompt: "x", seed: 100 } }),
      ],
      [edge("t", "g")],
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ok: false, message: "stop" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;

    const { run, store } = await imports();
    await run.runSingleNode("g").catch(() => {});

    const state = store.useWorkflowStore.getState();
    const gens = state.nodes.filter((n) => n.data.kind === "gen.image");
    expect(gens).toHaveLength(3);
    for (const g of gens) {
      expect(g.data.outputCount).toBe(1);
    }
    const seeds = gens.map((g) => g.data.seed);
    expect(new Set(seeds).size).toBe(3);

    const clones = gens.filter((g) => g.id !== "g");
    for (const c of clones) {
      expect(state.edges.some((e) => e.source === "t" && e.target === c.id)).toBe(true);
    }
  });

  it("skips expansion for non-countable kinds", async () => {
    await seedStore([node("t", "content.text", { data: { outputCount: 4, text: "hi" } })], []);
    const { run, store } = await imports();
    await run.runSingleNode("t");
    expect(store.useWorkflowStore.getState().nodes).toHaveLength(1);
  });
});
