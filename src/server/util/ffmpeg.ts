/**
 * ffmpeg wrapper — bootstraps the bundled binary from `@ffmpeg-installer/*`
 * so the app has zero external-dependency install steps (Electron ships the
 * binary inside the asar bundle).
 *
 * Scope is currently limited to what "Export final video" on a Frame needs:
 *   - ffprobe one file (width/height/fps/codec)
 *   - concat a list of files into one MP4
 *
 * If any part needs more than basic concat (e.g. cross-fade transitions,
 * normalisation) we'd rather add a dedicated wrapper than grow this one.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg") as { path: string; version: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobeInstaller = require("@ffprobe-installer/ffprobe") as { path: string; version: string };

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function getFfmpegPath(): string {
  return ffmpegInstaller.path;
}

export function getFfprobePath(): string {
  return ffprobeInstaller.path;
}

export interface ProbeResult {
  width: number;
  height: number;
  /** Frames per second as a rational-resolved float ("30000/1001" → 29.97). */
  fps: number;
  videoCodec: string;
  audioCodec?: string;
  /** Container duration in seconds (as reported by format.duration). */
  durationSec: number;
}

/** Parse an ffprobe rational like "30000/1001" into a plain number. */
function rationalToFloat(r: string | undefined): number {
  if (!r) return 0;
  if (!r.includes("/")) return Number(r) || 0;
  const [num, den] = r.split("/").map(Number);
  if (!den) return 0;
  return num / den;
}

export async function probeVideo(file: string): Promise<ProbeResult> {
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_streams",
    "-show_format",
    file,
  ];
  const stdout = await runAndCapture(getFfprobePath(), args);
  const j = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const video = j.streams?.find((s) => s.codec_type === "video");
  const audio = j.streams?.find((s) => s.codec_type === "audio");
  if (!video) {
    throw new Error(`ffprobe: không tìm thấy video stream trong ${file}`);
  }
  return {
    width: video.width || 0,
    height: video.height || 0,
    // r_frame_rate reflects the base/container framerate; avg_frame_rate can
    // report 0/0 on VFR files. Prefer r, fall back to avg.
    fps: rationalToFloat(video.r_frame_rate) || rationalToFloat(video.avg_frame_rate),
    videoCodec: video.codec_name || "unknown",
    audioCodec: audio?.codec_name,
    durationSec: Number(j.format?.duration) || 0,
  };
}

export interface ConcatOptions {
  /** Force re-encode even when the fast path (stream copy) would work. */
  reencode?: boolean;
  /** Overwrite the output file if it already exists. Defaults to true. */
  overwrite?: boolean;
}

/**
 * Decide whether the concat demuxer fast path is safe. The demuxer requires
 * identical codec, timebase, resolution, and pixel format across inputs — we
 * only check the easy-to-compare fields here (codec + WxH + fps ≈). If any
 * input fails, we fall back to the `concat` filter with H.264 re-encode, which
 * always works at the cost of CPU time.
 */
function canFastConcat(probes: ProbeResult[]): boolean {
  if (probes.length === 0) return false;
  const first = probes[0];
  for (const p of probes) {
    if (p.videoCodec !== first.videoCodec) return false;
    if (p.width !== first.width || p.height !== first.height) return false;
    // Allow small fps drift (29.97 vs 30) — concat demuxer is usually tolerant.
    if (Math.abs(p.fps - first.fps) > 0.5) return false;
  }
  return true;
}

/**
 * Concat the given inputs into `outputPath`. The function probes every input
 * first to pick the fast path vs filter path, so the caller doesn't need to
 * know which codec the workflow's videos came back as.
 */
export async function concatVideos(
  inputPaths: string[],
  outputPath: string,
  opts: ConcatOptions = {},
): Promise<{ fastPath: boolean; probes: ProbeResult[] }> {
  if (inputPaths.length === 0) {
    throw new Error("concatVideos: danh sách input rỗng");
  }
  if (inputPaths.length === 1) {
    // Single input → trivially fast. We still shell out to ffmpeg (instead of
    // fs.copyFile) so the output is guaranteed to be a valid MP4 + any
    // remuxing fixes get applied.
    await runFfmpeg([
      "-y",
      "-i", inputPaths[0],
      "-c", "copy",
      outputPath,
    ]);
    const probes = [await probeVideo(inputPaths[0])];
    return { fastPath: true, probes };
  }

  const probes = await Promise.all(inputPaths.map(probeVideo));

  const useFast = !opts.reencode && canFastConcat(probes);
  const overwriteFlag = opts.overwrite === false ? "-n" : "-y";

  if (useFast) {
    // Write the temporary "concat demuxer" list (one `file '…'` per line) and
    // point ffmpeg at it. The demuxer requires identical encoding so we only
    // take this path when `canFastConcat` agrees.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "wsu-concat-"));
    const listPath = path.join(tmpDir, "list.txt");
    const listBody = inputPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    writeFileSync(listPath, listBody, "utf-8");
    try {
      await runFfmpeg([
        overwriteFlag,
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        "-c", "copy",
        outputPath,
      ]);
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { fastPath: true, probes };
  }

  // Re-encode path: use the `concat` filter so we don't care about codec
  // uniformity. We normalise every input to the first input's WxH + SAR via
  // a scale+setsar prefix because the concat filter requires *all* inputs to
  // match (otherwise it errors with "Input link in1:v0 parameters do not
  // match"). H.264 + AAC at that resolution is a reasonable default.
  const hasAudioEverywhere = probes.every((p) => !!p.audioCodec);
  const targetW = probes[0].width;
  const targetH = probes[0].height;

  const filterParts: string[] = [];
  // Per-input normalize: scale to target, then setsar=1 to equalise pixel
  // aspect ratio. fps filter harmonises variable-framerate sources.
  for (let i = 0; i < inputPaths.length; i++) {
    filterParts.push(
      `[${i}:v:0]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`,
    );
  }
  const concatInputs: string[] = [];
  for (let i = 0; i < inputPaths.length; i++) {
    if (hasAudioEverywhere) concatInputs.push(`[v${i}][${i}:a:0]`);
    else concatInputs.push(`[v${i}]`);
  }
  const concatClause = hasAudioEverywhere
    ? `${concatInputs.join("")}concat=n=${inputPaths.length}:v=1:a=1[outv][outa]`
    : `${concatInputs.join("")}concat=n=${inputPaths.length}:v=1:a=0[outv]`;
  const filter = [...filterParts, concatClause].join(";");

  const args = [overwriteFlag];
  for (const p of inputPaths) {
    args.push("-i", p);
  }
  args.push("-filter_complex", filter);
  args.push("-map", "[outv]");
  if (hasAudioEverywhere) args.push("-map", "[outa]");
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
  );
  if (hasAudioEverywhere) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart", outputPath);

  await runFfmpeg(args);
  return { fastPath: false, probes };
}

/** Spawn ffmpeg and await completion, piping stderr to a rolling buffer for
 *  better error messages. */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegPath(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const CAP = 8 * 1024;
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < CAP) {
        stderr += chunk.toString("utf-8");
        if (stderr.length > CAP) stderr = stderr.slice(-CAP);
      }
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}:\n${stderr.trim().slice(-2000)}`));
    });
  });
}

function runAndCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exit ${code}:\n${stderr.trim().slice(-2000)}`));
    });
  });
}
