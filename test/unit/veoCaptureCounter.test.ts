import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetCaptureCounterForTests,
  bumpAndMaybeClear,
  preCaptureJitter,
  readClearEvery,
  shouldTriggerProactiveClear,
} from "@/server/providers/veo/captureCounter";

/**
 * Minimal collector double: we only exercise `clearSiteStorage`, the
 * one method `bumpAndMaybeClear` calls. Using a plain object (not a
 * VeoTokenCollector instance) avoids pulling Playwright + the Chrome
 * process manager into unit tests, which would otherwise fail to boot
 * inside Vitest.
 */
type ClearFn = (mode: "image" | "video") => Promise<void>;
function fakeCollector(clear: ClearFn) {
  return {
    clearSiteStorage: clear,
  } as unknown as import("@/server/tokens/veoTokenCollector").VeoTokenCollector;
}

describe("veo/captureCounter", () => {
  beforeEach(() => {
    __resetCaptureCounterForTests();
    delete process.env.VEO_CLEAR_STORAGE_EVERY;
    delete process.env.VEO_PRECAPTURE_JITTER_MIN_MS;
    delete process.env.VEO_PRECAPTURE_JITTER_MAX_MS;
  });

  afterEach(() => {
    __resetCaptureCounterForTests();
    delete process.env.VEO_CLEAR_STORAGE_EVERY;
    delete process.env.VEO_PRECAPTURE_JITTER_MIN_MS;
    delete process.env.VEO_PRECAPTURE_JITTER_MAX_MS;
  });

  describe("readClearEvery", () => {
    it("defaults to 6 when unset", () => {
      expect(readClearEvery()).toBe(6);
    });

    it("honours VEO_CLEAR_STORAGE_EVERY", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "4";
      expect(readClearEvery()).toBe(4);
    });

    it("treats negative values as 0 (disabled)", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "-1";
      expect(readClearEvery()).toBe(0);
    });

    it("ignores non-numeric values", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "garbage";
      expect(readClearEvery()).toBe(6);
    });
  });

  describe("shouldTriggerProactiveClear", () => {
    it("returns clear=true exactly on every Nth capture per mode", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "3";
      const results: boolean[] = [];
      for (let i = 0; i < 7; i++) {
        results.push(shouldTriggerProactiveClear("image").clear);
      }
      // captures 1,2 -> false; 3 -> true; 4,5 -> false; 6 -> true; 7 -> false
      expect(results).toEqual([false, false, true, false, false, true, false]);
    });

    it("counts image and video modes independently", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "2";
      // Image captures 1,2 → only #2 clears.
      expect(shouldTriggerProactiveClear("image").clear).toBe(false);
      expect(shouldTriggerProactiveClear("image").clear).toBe(true);
      // Video hasn't been touched yet; its first call is #1 for video.
      expect(shouldTriggerProactiveClear("video").clear).toBe(false);
      expect(shouldTriggerProactiveClear("video").clear).toBe(true);
    });

    it("never triggers when every=0 (disabled)", () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "0";
      for (let i = 0; i < 20; i++) {
        const { clear } = shouldTriggerProactiveClear("image");
        expect(clear).toBe(false);
      }
    });
  });

  describe("bumpAndMaybeClear", () => {
    it("calls clearSiteStorage only on boundary captures", async () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "3";
      const clear = vi.fn(async () => undefined);
      const collector = fakeCollector(clear);
      const log = vi.fn();

      for (let i = 0; i < 7; i++) {
        await bumpAndMaybeClear(collector, "image", log);
      }

      // Boundaries at captures #3 and #6 only → 2 clears total.
      expect(clear).toHaveBeenCalledTimes(2);
      expect(clear).toHaveBeenCalledWith("image");

      const logs = log.mock.calls.map((c) => c[0] as string);
      expect(logs.filter((m) => m.startsWith("Proactive storage clear"))).toHaveLength(2);
    });

    it("swallows clearSiteStorage failures (non-fatal)", async () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "2";
      const clear = vi.fn(async () => {
        throw new Error("Target closed");
      });
      const collector = fakeCollector(clear);
      const log = vi.fn();

      await bumpAndMaybeClear(collector, "image", log); // #1 no clear
      await expect(
        bumpAndMaybeClear(collector, "image", log), // #2 triggers the clear
      ).resolves.toBe(2);
      const logs = log.mock.calls.map((c) => c[0] as string);
      expect(logs.some((m) => m.includes("Proactive clear failed"))).toBe(true);
    });

    it("does not clear when every=0", async () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "0";
      const clear = vi.fn(async () => undefined);
      const collector = fakeCollector(clear);
      for (let i = 0; i < 10; i++) {
        await bumpAndMaybeClear(collector, "image");
      }
      expect(clear).not.toHaveBeenCalled();
    });

    it("returns the post-increment counter value", async () => {
      process.env.VEO_CLEAR_STORAGE_EVERY = "6";
      const clear = vi.fn(async () => undefined);
      const collector = fakeCollector(clear);
      const counts: number[] = [];
      for (let i = 0; i < 4; i++) {
        counts.push(await bumpAndMaybeClear(collector, "video"));
      }
      expect(counts).toEqual([1, 2, 3, 4]);
    });
  });

  describe("preCaptureJitter", () => {
    it("resolves within bounded time using defaults (300-1000ms)", async () => {
      const start = Date.now();
      await preCaptureJitter();
      const elapsed = Date.now() - start;
      // Generous upper bound keeps the test non-flaky on slow CI; the
      // contract being verified is "bounded", not "exactly within".
      expect(elapsed).toBeLessThan(2_000);
    });

    it("resolves instantly when max=0 is configured (disabled)", async () => {
      process.env.VEO_PRECAPTURE_JITTER_MIN_MS = "0";
      process.env.VEO_PRECAPTURE_JITTER_MAX_MS = "0";
      const start = Date.now();
      await preCaptureJitter();
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("respects custom min/max env vars", async () => {
      process.env.VEO_PRECAPTURE_JITTER_MIN_MS = "20";
      process.env.VEO_PRECAPTURE_JITTER_MAX_MS = "30";
      const start = Date.now();
      await preCaptureJitter();
      const elapsed = Date.now() - start;
      // cancelableSleep uses 200ms polling under the hood, so the actual
      // wake time can snap to the next tick. We only assert we don't
      // wait significantly longer than a single tick + the max jitter.
      expect(elapsed).toBeLessThan(500);
    });
  });
});
