import { describe, it, expect } from "vitest";

import { node, edge, seedStore } from "../_helpers/buildWorkflow";

async function importHelper() {
  const mod = await import("@/state/runWorkflow");
  return mod.computeEffectiveText;
}

describe("computeEffectiveText", () => {
  it("concatenates a linear text chain in edge order", async () => {
    await seedStore(
      [
        node("a", "content.text", { data: { text: "one" } }),
        node("b", "content.text", { data: { text: "two" } }),
        node("c", "content.text", { data: { text: "three" } }),
      ],
      [edge("a", "b"), edge("b", "c")],
    );
    const compute = await importHelper();
    expect(compute("c")).toBe("one\ntwo\nthree");
    expect(compute("b")).toBe("one\ntwo");
    expect(compute("a")).toBe("one");
  });

  it("merges multiple parallel text parents into one node", async () => {
    await seedStore(
      [
        node("a", "content.text", { data: { text: "cat" } }),
        node("b", "content.text", { data: { text: "black" } }),
        node("c", "content.text", { data: { text: "sleeping" } }),
      ],
      [edge("a", "c"), edge("b", "c")],
    );
    const compute = await importHelper();
    expect(compute("c")).toBe("cat\nblack\nsleeping");
  });

  it("ignores empty text segments", async () => {
    await seedStore(
      [
        node("a", "content.text", { data: { text: "  " } }),
        node("b", "content.text", { data: { text: "hi" } }),
      ],
      [edge("a", "b")],
    );
    const compute = await importHelper();
    expect(compute("b")).toBe("hi");
  });

  it("returns empty when the target is not a text node", async () => {
    await seedStore(
      [node("a", "gen.image", { data: { prompt: "x" } })],
      [],
    );
    const compute = await importHelper();
    expect(compute("a")).toBe("");
  });

  it("does not infinite-loop on a cycle", async () => {
    await seedStore(
      [
        node("a", "content.text", { data: { text: "x" } }),
        node("b", "content.text", { data: { text: "y" } }),
      ],
      [edge("a", "b"), edge("b", "a")],
    );
    const compute = await importHelper();
    const result = compute("a");
    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThan(100);
  });
});
