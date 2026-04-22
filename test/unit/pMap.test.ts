import { describe, expect, it } from "vitest";

import { pMapLimited } from "@/server/util/pMap";

describe("pMapLimited", () => {
  it("preserves input order in the result", async () => {
    const items = [3, 1, 4, 1, 5, 9, 2, 6];
    const out = await pMapLimited(items, 3, async (x) => {
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      return x * 2;
    });
    expect(out).toEqual(items.map((x) => x * 2));
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await pMapLimited(items, 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    });
    expect(peak).toBe(3);
  });

  it("handles empty input", async () => {
    const out = await pMapLimited([], 3, async (x) => x);
    expect(out).toEqual([]);
  });

  it("clamps limit <= items.length (no idle workers)", async () => {
    const calls: number[] = [];
    await pMapLimited([1, 2], 10, async (x) => {
      calls.push(x);
    });
    expect(calls.sort()).toEqual([1, 2]);
  });

  it("rejects if any fn rejects", async () => {
    await expect(
      pMapLimited([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      })
    ).rejects.toThrow("boom");
  });
});
