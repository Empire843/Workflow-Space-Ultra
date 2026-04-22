import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSpanAggregates,
  getSpanEntries,
  resetSpans,
  timedSpan,
  timedSpanSync,
} from "@/server/telemetry/timing";

afterEach(() => {
  resetSpans();
});

describe("timedSpan", () => {
  it("records duration + status=ok on success", async () => {
    await timedSpan("test.span", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "ok";
    });
    const entries = getSpanEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("test.span");
    expect(entries[0].status).toBe("ok");
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records status=error when the fn throws, then rethrows", async () => {
    await expect(
      timedSpan("test.fail", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const entries = getSpanEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("error");
  });

  it("calls log callback with formatted timing", async () => {
    const log = vi.fn();
    await timedSpan("test.log", async () => "x", log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/^\[timing\] test\.log=\d+ms$/);
  });

  it("log callback marks (error) suffix when throwing", async () => {
    const log = vi.fn();
    await expect(
      timedSpan("test.fail", async () => {
        throw new Error("x");
      }, log)
    ).rejects.toThrow();
    expect(log.mock.calls[0][0]).toMatch(/\(error\)$/);
  });

  it("timedSpanSync records for sync fns", () => {
    timedSpanSync("test.sync", () => 42);
    const entries = getSpanEntries();
    expect(entries.some((e) => e.name === "test.sync" && e.status === "ok")).toBe(true);
  });
});

describe("getSpanAggregates", () => {
  it("computes p50/p95/count/errors per span name", async () => {
    for (let i = 0; i < 10; i++) {
      await timedSpan("test.agg", async () => {
        await new Promise((r) => setTimeout(r, i));
      });
    }
    await expect(
      timedSpan("test.agg", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow();

    const agg = getSpanAggregates();
    const row = agg.find((a) => a.name === "test.agg");
    expect(row).toBeDefined();
    expect(row!.count).toBe(11);
    expect(row!.errors).toBe(1);
    expect(row!.p50Ms).toBeGreaterThanOrEqual(0);
    expect(row!.p95Ms).toBeGreaterThanOrEqual(row!.p50Ms);
    expect(row!.maxMs).toBeGreaterThanOrEqual(row!.p95Ms);
  });

  it("ring buffer caps at 500 entries (older events evicted)", async () => {
    for (let i = 0; i < 520; i++) {
      await timedSpan("test.ring", async () => {});
    }
    const entries = getSpanEntries();
    expect(entries.length).toBe(500);
  });
});
