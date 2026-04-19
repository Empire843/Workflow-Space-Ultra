import { describe, it, expect, beforeEach } from "vitest";

/**
 * Fresh-state helper — queue.ts caches a singleton on `globalThis.__wsu_queue`.
 * Re-import inside each test to start with an empty store.
 */
async function freshQueue() {
  const g = globalThis as unknown as { __wsu_queue?: unknown };
  delete g.__wsu_queue;
  const mod = await import("@/server/queue");
  return mod;
}

describe("queue safe emit", () => {
  beforeEach(async () => {
    await freshQueue();
  });

  it("emit() survives a listener that throws and still calls the others", async () => {
    const { createJob, emit, subscribeJob } = await freshQueue();
    const j = createJob({ nodeId: "n1", kind: "content.text" });

    const seen: string[] = [];
    subscribeJob(j.id, () => {
      throw new Error("bad listener");
    });
    subscribeJob(j.id, (ev) => {
      if (ev.type === "log") seen.push(ev.log || "");
    });

    // This used to crash synchronously; with the safe emit() the good listener
    // still runs.
    expect(() =>
      emit({ type: "log", jobId: j.id, log: "hello", timestamp: Date.now() }),
    ).not.toThrow();
    expect(seen).toEqual(["hello"]);
  });
});

describe("queue helpers", () => {
  beforeEach(async () => {
    await freshQueue();
  });

  it("listJobs returns newest-first", async () => {
    const q = await freshQueue();
    const a = q.createJob({ nodeId: "na", kind: "content.text" });
    // Sleep so createdAt differs
    await new Promise((r) => setTimeout(r, 5));
    const b = q.createJob({ nodeId: "nb", kind: "content.text" });
    const list = q.listJobs();
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it("clearFinishedJobs only drops terminal jobs", async () => {
    const q = await freshQueue();
    const running = q.createJob({ nodeId: "nr", kind: "content.text" });
    q.setJobStatus(running.id, "running");

    const done = q.createJob({ nodeId: "nd", kind: "content.text" });
    q.setJobStatus(done.id, "done");

    const err = q.createJob({ nodeId: "ne", kind: "content.text" });
    q.setJobStatus(err.id, "error");

    expect(q.clearFinishedJobs()).toBe(2);
    expect(q.listJobs().map((j) => j.id)).toEqual([running.id]);
  });

  it("cancelAllActiveJobs marks queued as cancelled and sets cancelRequested on running", async () => {
    const q = await freshQueue();
    const queued = q.createJob({ nodeId: "nq", kind: "content.text" });
    const running = q.createJob({ nodeId: "nr", kind: "content.text" });
    q.setJobStatus(running.id, "running");

    const n = q.cancelAllActiveJobs();
    expect(n).toBe(2);

    expect(q.getJob(queued.id)?.status).toBe("cancelled");
    expect(q.getJob(running.id)?.status).toBe("running");
    expect(q.getJob(running.id)?.cancelRequested).toBe(true);
  });
});
