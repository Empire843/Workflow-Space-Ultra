import { describe, it, expect } from "vitest";

import { EnqueueJobSchema, JobEventSchema } from "@/lib/schemas/api";

describe("EnqueueJobSchema", () => {
  it("accepts minimal valid body", () => {
    const r = EnqueueJobSchema.safeParse({
      nodeId: "n1",
      kind: "gen.image",
      data: { prompt: "hi" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const r = EnqueueJobSchema.safeParse({ nodeId: "n1", kind: "bogus.kind", data: {} });
    expect(r.success).toBe(false);
  });

  it("requires nodeId", () => {
    const r = EnqueueJobSchema.safeParse({ kind: "gen.image", data: {} });
    expect(r.success).toBe(false);
  });

  it("passes through extra data keys", () => {
    const r = EnqueueJobSchema.safeParse({
      nodeId: "n",
      kind: "gen.video",
      data: { prompt: "x", futureField: 42 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data.data as { futureField?: number }).futureField).toBe(42);
    }
  });
});

describe("JobEventSchema", () => {
  it("accepts each event variant", () => {
    for (const ev of [
      { type: "snapshot", job: { status: "running" } },
      { type: "progress", progress: 50 },
      { type: "output", output: { imageUrl: "x" } },
      { type: "status", status: "done" },
      { type: "error", error: "boom" },
      { type: "ping" },
    ]) {
      const r = JobEventSchema.safeParse(ev);
      expect(r.success, JSON.stringify(ev)).toBe(true);
    }
  });

  it("rejects progress > 100", () => {
    expect(JobEventSchema.safeParse({ type: "progress", progress: 101 }).success).toBe(false);
  });
});
