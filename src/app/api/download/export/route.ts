import { existsSync } from "node:fs";
import { copyFile, link, mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";
import { z } from "zod";

import { loadConfig } from "@/server/config";
import { parseJsonBody } from "@/server/http/validate";
import { resolveLocalMediaPath } from "@/server/paths/workflowAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/download/export
 *
 * Server-side "Save As" for media that already lives in the workflow cache
 * (`Workflows/<id>/assets/outputs/<file>`). For each item the route:
 *   1. Resolves the `sourceUrl` (must be a local `/api/workflows/...` or
 *      `/api/files/...` URL that maps inside `BASE_DIR`).
 *   2. Computes `<EXPORT_DIR>/<subdir?>/<filename>` with collision-safe
 *      rename (`name (1).ext`, `name (2).ext`, ...).
 *   3. Tries `fs.link` first — on the same volume this is a hardlink,
 *      **0 extra bytes**, and the app's preview keeps working because the
 *      bytes at `Workflows/...` are unchanged. Falls back to `fs.copyFile`
 *      on `EXDEV` (destination on a different filesystem / drive).
 *
 * The original file in `Workflows/` is never deleted — it's the app's
 * durable cache (survives account swaps / expired remote URLs).
 */

const ExportItem = z.object({
  /** Local preview URL: `/api/workflows/<id>/assets/...` or `/api/files/...`. */
  sourceUrl: z.string().min(1),
  /** Final filename the user should see (incl. extension). Server sanitizes. */
  filename: z.string().min(1).max(240),
  /**
   * Optional relative subdirectory under EXPORT_DIR. Useful for Frame bulk
   * export: each frame gets its own folder so scenes don't collide across
   * frames. Server strips `..` and leading slashes.
   */
  subdir: z.string().max(240).optional(),
});

const ExportRequestSchema = z.object({
  items: z.array(ExportItem).min(1).max(200),
});

/** Replace filesystem-unsafe characters and trim. Mirrors the sanitizer in
 *  `/api/download` so filenames round-trip consistently. */
function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").slice(0, 200) || "download";
}

/** Strip leading slashes + `..` components so a caller can't escape EXPORT_DIR
 *  by passing `subdir: "../../etc"`. Result may still be empty. */
function sanitizeSubdir(subdir: string | undefined): string {
  if (!subdir) return "";
  const parts = subdir
    .split(/[\\/]+/g)
    .map((p) => p.trim())
    .filter((p) => p && p !== "." && p !== "..")
    .map((p) => sanitizeName(p));
  return parts.join(path.sep);
}

/** If `dest` exists, return `dest` with ` (1)`, ` (2)`, ... inserted before
 *  the extension until a free slot is found. Caps at 500 tries so a
 *  runaway loop can't wedge the request. */
async function nextFreePath(dest: string): Promise<string> {
  if (!existsSync(dest)) return dest;
  const parsed = path.parse(dest);
  for (let i = 1; i < 500; i++) {
    const candidate = path.join(parsed.dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many files with similar names in export folder");
}

interface ExportResult {
  ok: boolean;
  /** Absolute path the file was written / linked to. */
  destPath?: string;
  /** `hardlink` on same-volume; `copy` on `EXDEV` fallback. */
  method?: "hardlink" | "copy";
  sourceUrl: string;
  filename: string;
  error?: string;
}

export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, ExportRequestSchema);
  if ("response" in parsed) return parsed.response;

  const cfg = loadConfig();
  const exportDir = cfg.EXPORT_DIR?.trim();
  if (!exportDir) {
    return NextResponse.json(
      { ok: false, message: "EXPORT_DIR chưa được cấu hình. Mở Settings → Export folder." },
      { status: 400 },
    );
  }

  // The user-chosen EXPORT_DIR must be an absolute path. Relative paths would
  // be resolved against the Next server CWD which is usually inside the repo
  // — surprising behaviour, and the whole point of this feature is to dump
  // deliverables OUTSIDE the app sandbox.
  if (!path.isAbsolute(exportDir)) {
    return NextResponse.json(
      {
        ok: false,
        message: `EXPORT_DIR phải là đường dẫn tuyệt đối: "${exportDir}"`,
      },
      { status: 400 },
    );
  }

  // Create it on first use so the user doesn't need to mkdir by hand.
  try {
    await mkdir(exportDir, { recursive: true });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        message: `Không tạo được EXPORT_DIR: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 500 },
    );
  }

  const results: ExportResult[] = [];

  for (const item of parsed.data.items) {
    const res: ExportResult = {
      ok: false,
      sourceUrl: item.sourceUrl,
      filename: item.filename,
    };

    const src = resolveLocalMediaPath(item.sourceUrl);
    if (!src) {
      res.error =
        "Source không phải local asset — chỉ media đã được tải về `Workflows/` mới export được.";
      results.push(res);
      continue;
    }
    try {
      const st = await stat(src);
      if (!st.isFile()) {
        res.error = "Source không phải file";
        results.push(res);
        continue;
      }
    } catch {
      res.error = "File gốc không tồn tại (cache có thể đã bị dọn)";
      results.push(res);
      continue;
    }

    const sub = sanitizeSubdir(item.subdir);
    const targetDir = sub ? path.join(exportDir, sub) : exportDir;
    try {
      await mkdir(targetDir, { recursive: true });
    } catch (err) {
      res.error = `Không tạo subdir: ${err instanceof Error ? err.message : String(err)}`;
      results.push(res);
      continue;
    }

    const wantedName = sanitizeName(item.filename);
    const initial = path.join(targetDir, wantedName);
    let dest: string;
    try {
      dest = await nextFreePath(initial);
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
      results.push(res);
      continue;
    }

    // Hardlink first. On Windows NTFS / macOS APFS / Linux this is free
    // (shared inode). On ReFS or cross-volume writes the kernel raises
    // EXDEV — Node surfaces the syscall code verbatim so we can detect and
    // fall back without re-reading the source. Any other error is fatal
    // for this item.
    try {
      await link(src, dest);
      res.ok = true;
      res.destPath = dest;
      res.method = "hardlink";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV" || code === "EPERM" || code === "ENOSYS") {
        try {
          await copyFile(src, dest);
          res.ok = true;
          res.destPath = dest;
          res.method = "copy";
        } catch (copyErr) {
          res.error =
            copyErr instanceof Error ? copyErr.message : String(copyErr);
        }
      } else {
        res.error = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(res);
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: okCount === results.length,
    exportDir,
    results,
  });
}
