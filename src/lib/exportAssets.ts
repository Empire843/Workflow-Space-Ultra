"use client";

/**
 * Client helper for the "Download / Export" feature. Wraps the POST
 * `/api/download/export` endpoint and surfaces success / failure via the
 * global toaster. Callers:
 *   - `DownloadToolButton` on each media node (single item)
 *   - `FrameNode` bulk "Download Frame" button (many items, subdir = frame label)
 *
 * If the server returns `400` (EXPORT_DIR chưa cấu hình), `exportAssets`
 * returns `needsConfig: true` so the caller can fall back to the legacy
 * browser-download flow (via `<a download>`) and nudge the user toward
 * Settings.
 */

import { toast } from "@/state/toastStore";

export interface ExportItem {
  /** A local preview URL: `/api/workflows/<id>/assets/...` or `/api/files/...`. */
  sourceUrl: string;
  /** Human-friendly filename incl. extension. */
  filename: string;
  /** Optional subdirectory under the configured EXPORT_DIR. */
  subdir?: string;
}

export interface ExportResult {
  ok: boolean;
  destPath?: string;
  method?: "hardlink" | "copy";
  sourceUrl: string;
  filename: string;
  error?: string;
}

interface ExportResponse {
  ok: boolean;
  exportDir?: string;
  results?: ExportResult[];
  /** Populated on 400/500 — typically "EXPORT_DIR chưa cấu hình". */
  message?: string;
}

export interface ExportOutcome {
  /** `true` if the server returned 400 with a config-missing message.
   *  Callers should then fall back to the browser-download flow. */
  needsConfig: boolean;
  /** Fully succeeded (all items ok) — false when any item failed. */
  ok: boolean;
  /** Successfully-exported item count. */
  okCount: number;
  /** Total item count. */
  total: number;
  /** Raw server results (empty when `needsConfig`). */
  results: ExportResult[];
  /** Absolute EXPORT_DIR path echoed by the server (for toasts). */
  exportDir?: string;
}

/** Only the `/` (absolute) and `/api/...` variants are accepted by the server.
 *  This guards against someone trying to export a `data:` URL or external
 *  link — in those cases we can't possibly hardlink/copy on disk. */
export function isLocalAssetUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  return url.startsWith("/api/workflows/") || url.startsWith("/api/files/");
}

export async function exportAssets(
  items: ExportItem[],
  opts?: { silent?: boolean; successLabel?: string },
): Promise<ExportOutcome> {
  if (items.length === 0) {
    return { needsConfig: false, ok: true, okCount: 0, total: 0, results: [] };
  }

  let data: ExportResponse;
  try {
    const res = await fetch("/api/download/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    data = (await res.json()) as ExportResponse;
    if (res.status === 400 && /EXPORT_DIR|export folder/i.test(data.message || "")) {
      return {
        needsConfig: true,
        ok: false,
        okCount: 0,
        total: items.length,
        results: [],
      };
    }
    if (!res.ok && !data.results) {
      if (!opts?.silent) {
        toast.error("Export thất bại", data.message || `HTTP ${res.status}`);
      }
      return { needsConfig: false, ok: false, okCount: 0, total: items.length, results: [] };
    }
  } catch (err) {
    if (!opts?.silent) {
      toast.error(
        "Export lỗi mạng",
        err instanceof Error ? err.message : String(err),
      );
    }
    return { needsConfig: false, ok: false, okCount: 0, total: items.length, results: [] };
  }

  const results = data.results ?? [];
  const okCount = results.filter((r) => r.ok).length;
  const outcome: ExportOutcome = {
    needsConfig: false,
    ok: okCount === results.length && okCount > 0,
    okCount,
    total: results.length,
    results,
    exportDir: data.exportDir,
  };

  if (!opts?.silent) {
    if (outcome.ok) {
      const label = opts?.successLabel ?? (outcome.total === 1 ? "Đã export 1 file" : `Đã export ${outcome.okCount} file`);
      // Hardlink method is worth surfacing so users don't panic about disk
      // bloat ("Wait, the file is in my export folder AND still in Workflows?
      // Is it taking 2× space?"). Short note clarifies.
      const anyHardlink = results.some((r) => r.method === "hardlink");
      const detail = outcome.exportDir
        ? `${outcome.exportDir}${anyHardlink ? " · hardlink (0 byte thêm)" : ""}`
        : undefined;
      toast.success(label, detail);
    } else if (okCount > 0) {
      const firstErr = results.find((r) => !r.ok)?.error;
      toast.error(
        `Export một phần: ${okCount}/${outcome.total}`,
        firstErr ?? undefined,
      );
    } else {
      const firstErr = results.find((r) => r.error)?.error;
      toast.error("Export thất bại", firstErr ?? "Không có file nào được export.");
    }
  }

  return outcome;
}
