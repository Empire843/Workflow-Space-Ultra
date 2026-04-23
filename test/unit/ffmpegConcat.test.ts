/**
 * Unit tests for `concatVideos` in `@/server/util/ffmpeg`.
 *
 * These are effectively integration tests because they spawn the real bundled
 * ffmpeg binary — but the binary ships with `@ffmpeg-installer/ffmpeg`, so
 * they run without any extra CI setup. We generate two short test clips from
 * ffmpeg's built-in `testsrc` source so we don't depend on any fixture file
 * checked into the repo.
 *
 * Every clip and concat output lands in an OS tmpdir that's deleted on exit.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  concatVideos,
  getFfmpegPath,
  probeVideo,
} from "@/server/util/ffmpeg";

let tmpDir: string;
let clipA: string;
let clipB: string;
let clipC_DifferentRes: string;

function makeClip(outPath: string, durationSec: number, size: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // `testsrc` generates a colour-bar pattern with burned-in timecode; we
    // ask for 30 fps + H.264 yuv420p so the output is a compatible MP4.
    const proc = spawn(
      getFfmpegPath(),
      [
        "-y",
        "-f", "lavfi",
        "-i", `testsrc=duration=${durationSec}:size=${size}:rate=30`,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (c: Buffer) => (err += c.toString("utf-8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg fixture failed (${code}):\n${err.slice(-1500)}`));
    });
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "wsu-ffmpeg-test-"));
  clipA = path.join(tmpDir, "a.mp4");
  clipB = path.join(tmpDir, "b.mp4");
  clipC_DifferentRes = path.join(tmpDir, "c-different.mp4");
  // 1s clips keep the test under ~3s total wall time on most machines.
  await makeClip(clipA, 1, "320x240");
  await makeClip(clipB, 1, "320x240");
  // Different resolution → forces the `concat` filter fallback path.
  await makeClip(clipC_DifferentRes, 1, "640x360");
}, 30_000);

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("probeVideo", () => {
  it("reports width/height/fps for a generated clip", async () => {
    const p = await probeVideo(clipA);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
    expect(p.fps).toBeCloseTo(30, 0);
    expect(p.videoCodec).toMatch(/h264|libx264/i);
    // 1-second clip may have slight drift (0.966–1.04) depending on GOP.
    expect(p.durationSec).toBeGreaterThan(0.5);
    expect(p.durationSec).toBeLessThan(2);
  });
});

describe("concatVideos", () => {
  it("uses fast-path (stream copy) when inputs match", async () => {
    const out = path.join(tmpDir, "out-fast.mp4");
    const r = await concatVideos([clipA, clipB], out);
    expect(r.fastPath).toBe(true);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(0);
    const p = await probeVideo(out);
    expect(p.durationSec).toBeGreaterThan(1.4);
    expect(p.durationSec).toBeLessThan(3);
    expect(p.width).toBe(320);
    expect(p.height).toBe(240);
  }, 30_000);

  it("falls back to re-encode when inputs differ in resolution", async () => {
    const out = path.join(tmpDir, "out-reencode.mp4");
    const r = await concatVideos([clipA, clipC_DifferentRes], out);
    expect(r.fastPath).toBe(false);
    expect(existsSync(out)).toBe(true);
    const p = await probeVideo(out);
    // Re-encode uses first input's resolution via concat filter.
    expect(p.width).toBeGreaterThan(0);
    expect(p.durationSec).toBeGreaterThan(1.4);
    expect(p.durationSec).toBeLessThan(3);
  }, 60_000);

  it("can be forced to re-encode even when fast-path would work", async () => {
    const out = path.join(tmpDir, "out-forced.mp4");
    const r = await concatVideos([clipA, clipB], out, { reencode: true });
    expect(r.fastPath).toBe(false);
    expect(existsSync(out)).toBe(true);
  }, 60_000);

  it("handles a single input by remuxing it", async () => {
    const out = path.join(tmpDir, "out-single.mp4");
    const r = await concatVideos([clipA], out);
    expect(r.fastPath).toBe(true);
    expect(existsSync(out)).toBe(true);
    const p = await probeVideo(out);
    expect(p.durationSec).toBeGreaterThan(0.5);
  }, 30_000);

  it("rejects empty input list", async () => {
    await expect(concatVideos([], path.join(tmpDir, "x.mp4"))).rejects.toThrow(/rỗng/);
  });
});
