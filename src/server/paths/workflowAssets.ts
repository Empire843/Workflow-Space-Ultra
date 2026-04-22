import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { BASE_DIR, DOWNLOADS_DIR, WORKFLOWS_DIR } from "../config";

/**
 * Filesystem layout for workflow-scoped media assets.
 *
 *   Workflows/
 *     <workflowId>/
 *       assets/
 *         outputs/   ← generated images/videos pulled down from VEO/Grok
 *         uploads/   ← files the user dropped onto an Upload node
 *
 * Why one folder per workflow?
 *   - Swapping Google / xAI accounts mid-project used to silently invalidate
 *     every remote URL the workflow held; now we keep a local copy so previews
 *     keep working regardless of which account is logged in.
 *   - Deleting a workflow can remove its entire folder in one operation.
 *   - Easy to ship a workflow bundle (just zip the folder + the graph export).
 *
 * Nothing in here creates a folder that wasn't explicitly requested — callers
 * opt in via {@link ensureWorkflowAssetDir}.
 */

/** Workflow ids we generate look like `wf_<ts>_<rand>` already, but ids from
 * imported workflows or the user can be anything — reject anything that could
 * escape the WORKFLOWS_DIR sandbox before we touch the filesystem. */
export function sanitizeWorkflowId(id: string | undefined | null): string | null {
  if (!id) return null;
  const trimmed = String(id).trim();
  if (!trimmed) return null;
  // Only allow the characters a typical id would contain. `..`, `/`, `\` are
  // implicitly rejected — a sandbox the route handler can trust.
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(trimmed)) return null;
  return trimmed;
}

/** Absolute path of the workflow root (`Workflows/<id>`). */
export function workflowDir(workflowId: string): string {
  const safe = sanitizeWorkflowId(workflowId);
  if (!safe) throw new Error(`Invalid workflowId: ${workflowId}`);
  return path.join(WORKFLOWS_DIR, safe);
}

/** Absolute path of the workflow assets root (`Workflows/<id>/assets`). */
export function workflowAssetsDir(workflowId: string): string {
  return path.join(workflowDir(workflowId), "assets");
}

/**
 * Resolve `Workflows/<id>/assets/<...segments>` and guarantee the file stays
 * inside the workflow's own assets directory — this is the single hardening
 * point shared by the serving route, the downloader, and the upload handler.
 *
 * Returns `null` if the resulting path would escape the sandbox.
 */
export function workflowAssetPath(
  workflowId: string,
  ...segments: string[]
): string | null {
  const root = workflowAssetsDir(workflowId);
  const joined = path.resolve(root, ...segments);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (joined !== root && !joined.startsWith(rootWithSep)) return null;
  return joined;
}

/** Relative URL the client uses to fetch an asset. */
export function workflowAssetUrl(workflowId: string, ...segments: string[]): string {
  const parts = segments
    .flatMap((s) => String(s).split(/[\\/]/))
    .filter(Boolean)
    .map((s) => encodeURIComponent(s));
  return `/api/workflows/${encodeURIComponent(workflowId)}/assets/${parts.join("/")}`;
}

/** Ensure the `assets/<subdir>` folder exists. Returns the absolute path. */
export function ensureWorkflowAssetDir(workflowId: string, subdir: string): string {
  const abs = workflowAssetPath(workflowId, subdir);
  if (!abs) throw new Error(`Invalid asset subdir: ${subdir}`);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * Where a download should land. When a workflowId is supplied we use
 * `Workflows/<id>/assets/outputs/`; otherwise we fall back to the flat
 * `downloads/` folder for legacy callers (ad-hoc tests, single-node runs
 * without an open workflow).
 */
export function resolveDownloadDir(workflowId?: string | null): {
  dir: string;
  workflowScoped: boolean;
} {
  const safe = sanitizeWorkflowId(workflowId ?? undefined);
  if (safe) {
    return { dir: ensureWorkflowAssetDir(safe, "outputs"), workflowScoped: true };
  }
  return { dir: DOWNLOADS_DIR, workflowScoped: false };
}

/**
 * Write base64-encoded bytes to `Workflows/<id>/assets/outputs/<fileName>`
 * (or `downloads/<fileName>` if there is no workflow). Returns the absolute
 * path so the caller can run {@link downloadedAssetUrl} for the preview URL.
 */
export async function writeBase64Asset(
  workflowId: string | null | undefined,
  fileName: string,
  base64: string,
): Promise<string> {
  const { dir } = resolveDownloadDir(workflowId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, path.basename(fileName));
  await writeFile(abs, Buffer.from(base64, "base64"));
  return abs;
}

/**
 * Resolve a local media URL (the kind this tool emits — `/api/workflows/<id>/
 * assets/...` or `/api/files/...`) back to an absolute disk path so the
 * executor can read the bytes without looping through HTTP. Returns `null`
 * for remote URLs, data URIs, or anything that escapes the sandbox.
 */
export function resolveLocalMediaPath(urlOrPath: string | undefined | null): string | null {
  if (!urlOrPath) return null;
  const s = String(urlOrPath).trim();
  if (!s || s.startsWith("data:") || /^https?:\/\//i.test(s)) return null;

  // /api/workflows/<id>/assets/<...>
  const wfMatch = s.match(/^\/api\/workflows\/([^/]+)\/assets\/(.+)$/);
  if (wfMatch) {
    const id = sanitizeWorkflowId(decodeURIComponent(wfMatch[1]));
    if (!id) return null;
    const segs = wfMatch[2].split("/").map((p) => decodeURIComponent(p));
    return workflowAssetPath(id, ...segs);
  }

  // /api/files/<name>
  const filesMatch = s.match(/^\/api\/files\/(.+)$/);
  if (filesMatch) {
    const name = path.basename(decodeURIComponent(filesMatch[1]));
    return path.join(DOWNLOADS_DIR, name);
  }

  // Bare absolute path that still lives inside BASE_DIR (Workflows/ or
  // downloads/). Prevents arbitrary filesystem reads while letting legacy
  // data with raw paths keep working.
  const resolved = path.resolve(s);
  const baseWithSep = BASE_DIR.endsWith(path.sep) ? BASE_DIR : BASE_DIR + path.sep;
  if (resolved === BASE_DIR || resolved.startsWith(baseWithSep)) {
    return resolved;
  }
  return null;
}

/** Build the preview URL for a file that was just written to a workflow folder. */
export function downloadedAssetUrl(
  workflowId: string | null | undefined,
  absPath: string,
): string {
  const safe = sanitizeWorkflowId(workflowId ?? undefined);
  if (safe) {
    const root = workflowAssetsDir(safe);
    const rel = path.relative(root, absPath).split(path.sep).filter(Boolean);
    if (rel.length && !rel[0].startsWith("..")) {
      return workflowAssetUrl(safe, ...rel);
    }
  }
  return `/api/files/${path.basename(absPath)}`;
}
