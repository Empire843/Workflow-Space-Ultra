import { describe, it, expect, beforeEach, vi } from "vitest";

import { node, edge, seedStore } from "../_helpers/buildWorkflow";
import { installFakeJobs, successJob } from "../_helpers/mockJobServer";

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

describe("runWorkflow topological execution", () => {
  it("POSTs each gen node in valid topological order on a diamond graph", async () => {
    await seedStore(
      [
        node("a", "content.text", { data: { text: "prompt" } }),
        node("b", "gen.image", { data: { prompt: "B" } }),
        node("c", "gen.image", { data: { prompt: "C" } }),
        node("d", "gen.video", { data: { prompt: "D", genMode: "i2v.veo" } }),
      ],
      [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")],
    );

    installFakeJobs({
      scripts: {
        b: successJob({ imageMediaId: "mb", imageUrl: "http://x/b.png" }),
        c: successJob({ imageMediaId: "mc", imageUrl: "http://x/c.png" }),
        d: successJob({ videoUrl: "http://x/d.mp4" }),
      },
    });

    const order: string[] = [];
    const wrapped = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/jobs" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        order.push(body.nodeId);
      }
      return wrapped(input as RequestInfo | URL, init);
    }) as typeof globalThis.fetch;

    const { run } = await imports();
    await run.runWorkflow({ maxInFlight: 4 });

    expect(order).toHaveLength(3);
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  }, 15_000);
});
