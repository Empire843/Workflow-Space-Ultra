import { describe, it, expect, beforeEach } from "vitest";

/**
 * Tests target the pure queue/FIFO/concurrency behavior of lanes.ts. The module
 * caches its state on `globalThis.__wsu_lanes`; we reset it before each test.
 */
async function freshLanes() {
  const g = globalThis as unknown as { __wsu_lanes?: unknown };
  delete g.__wsu_lanes;
  const mod = await import("@/server/lanes");
  return mod;
}

function deferred<T = void>(): { p: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
}

describe("lanes.providerOf", () => {
  beforeEach(async () => {
    await freshLanes();
  });

  it("classifies gen.video by genMode (grok / veo)", async () => {
    const { providerOf } = await freshLanes();
    expect(providerOf("gen.video", "t2v.grok")).toBe("grok");
    expect(providerOf("gen.video", "i2v.veo")).toBe("veo");
  });

  it("falls back to NODE_CATALOG entry provider when genMode absent", async () => {
    const { providerOf } = await freshLanes();
    expect(providerOf("content.text")).toBe("local");
  });
});

describe("lanes.runInLane", () => {
  it("serializes tasks when concurrency=1", async () => {
    const { runInLane, setLaneConcurrency } = await freshLanes();
    setLaneConcurrency("veo", 1);

    const started: number[] = [];
    const gate1 = deferred();
    const gate2 = deferred();

    const t1 = runInLane("veo", async () => {
      started.push(1);
      await gate1.p;
      return "a";
    });
    const t2 = runInLane("veo", async () => {
      started.push(2);
      await gate2.p;
      return "b";
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1]);

    gate1.resolve();
    await t1;
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([1, 2]);

    gate2.resolve();
    const [a, b] = await Promise.all([t1, t2]);
    expect([a, b]).toEqual(["a", "b"]);
  });

  it("runs up to concurrency in parallel and preserves FIFO order", async () => {
    const { runInLane, setLaneConcurrency } = await freshLanes();
    setLaneConcurrency("local", 2);

    const startedAt: Record<string, number> = {};
    const gates = [deferred(), deferred(), deferred(), deferred()];

    const promises = ["a", "b", "c", "d"].map((name, i) =>
      runInLane("local", async () => {
        startedAt[name] = Date.now();
        await gates[i].p;
        return name;
      }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(startedAt).sort()).toEqual(["a", "b"]);

    gates[0].resolve();
    await promises[0];
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(startedAt).sort()).toEqual(["a", "b", "c"]);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    expect(await Promise.all(promises)).toEqual(["a", "b", "c", "d"]);
  });

  it("continues draining after a task rejects", async () => {
    const { runInLane, setLaneConcurrency } = await freshLanes();
    setLaneConcurrency("grok", 1);

    const gate = deferred();
    const t1 = runInLane("grok", async () => {
      throw new Error("boom");
    });
    const t2 = runInLane("grok", async () => {
      await gate.p;
      return "ok";
    });

    await expect(t1).rejects.toThrow("boom");
    gate.resolve();
    await expect(t2).resolves.toBe("ok");
  });

  it("setLaneConcurrency drains queued tasks when raised", async () => {
    const { runInLane, setLaneConcurrency } = await freshLanes();
    setLaneConcurrency("local", 1);

    const started: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    const p = [
      runInLane("local", async () => {
        started.push("a");
        await gates[0].p;
      }),
      runInLane("local", async () => {
        started.push("b");
        await gates[1].p;
      }),
      runInLane("local", async () => {
        started.push("c");
        await gates[2].p;
      }),
    ];

    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]);

    setLaneConcurrency("local", 3);
    await new Promise((r) => setTimeout(r, 0));
    expect(started.sort()).toEqual(["a", "b", "c"]);

    gates.forEach((g) => g.resolve());
    await Promise.all(p);
  });
});
