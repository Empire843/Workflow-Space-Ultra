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

  it("decrements lane.active even when the settle handler throws", async () => {
    // Regression: the old drain() called task.resolve(v) outside try/catch.
    // If a downstream listener (e.g. SSE send) threw synchronously, the
    // `.finally` still fired BUT the `.then(resolve)` callback's error
    // propagated to unhandledRejection. Here we simulate a resolve handler
    // that throws synchronously and verify the lane still accepts more work.
    const { runInLane, setLaneConcurrency, getLaneStats } = await freshLanes();
    setLaneConcurrency("grok", 1);

    // First task resolves; we attach a .then that throws to mimic a broken
    // listener. The lane must still drain the next task.
    const p1 = runInLane("grok", async () => "first");
    p1.then(() => {
      throw new Error("listener exploded");
    }).catch(() => { /* swallow for test */ });

    await expect(p1).resolves.toBe("first");

    // active must be back to 0 so the next task runs immediately.
    const p2 = runInLane("grok", async () => "second");
    await expect(p2).resolves.toBe("second");

    expect(getLaneStats().grok.active).toBe(0);
  });

  it("cancelQueuedTasks rejects waiting tasks without running them", async () => {
    const { runInLane, cancelQueuedTasks, setLaneConcurrency, getLaneStats } = await freshLanes();
    setLaneConcurrency("veo", 1);

    const gate = deferred();
    const running = runInLane("veo", async () => {
      await gate.p;
      return "running";
    });

    let ranB = false;
    const p2 = runInLane("veo", async () => {
      ranB = true;
      return "b";
    });
    let ranC = false;
    const p3 = runInLane("veo", async () => {
      ranC = true;
      return "c";
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(getLaneStats().veo.queued).toBe(2);

    const dropped = cancelQueuedTasks();
    expect(dropped).toBeGreaterThanOrEqual(2);
    await expect(p2).rejects.toThrow("Cancelled");
    await expect(p3).rejects.toThrow("Cancelled");
    expect(ranB).toBe(false);
    expect(ranC).toBe(false);

    gate.resolve();
    await expect(running).resolves.toBe("running");
  });

  it("resetAllLanes zeroes active counter (emergency escape hatch)", async () => {
    const { runInLane, setLaneConcurrency, resetAllLanes, getLaneStats } = await freshLanes();
    setLaneConcurrency("grok", 1);

    const gate = deferred();
    const p = runInLane("grok", async () => {
      await gate.p;
      return "done";
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(getLaneStats().grok.active).toBe(1);

    const result = resetAllLanes();
    expect(result.activeReset.grok).toBe(1);
    expect(getLaneStats().grok.active).toBe(0);

    // The still-pending promise resolves when we open the gate — it's now
    // detached from lane bookkeeping but doesn't throw.
    gate.resolve();
    await expect(p).resolves.toBe("done");
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
