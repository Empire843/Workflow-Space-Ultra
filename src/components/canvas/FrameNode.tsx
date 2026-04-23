"use client";

import React from "react";
import {
  NodeResizer,
  type NodeProps,
} from "@xyflow/react";
import {
  CheckCircle2,
  Download,
  Film,
  Frame as FrameIcon,
  Loader2,
  Play,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { exportAssets, isLocalAssetUrl, type ExportItem } from "@/lib/exportAssets";
import type { NodeDataBase, OutputItem } from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { runFrame } from "@/state/runWorkflow";
import { toast } from "@/state/toastStore";
import { getFrameVideoChildren, useWorkflowStore } from "@/state/workflowStore";

/**
 * Frame node — a visual group container. Other nodes dropped inside a Frame
 * become children (`parentId`, see `workflowStore`). We intentionally do NOT
 * apply `extent: "parent"` so the user can freely drag children anywhere;
 * dropping a child outside the frame simply detaches it on dragEnd.
 * Dragging a Frame drags the whole group. The "Run Frame" button forces a
 * topological, sequential re-run of every child via `runFrame(frameId)`.
 *
 * Visual goals (per user feedback "đẹp, dễ nhận biết, dễ nhìn"):
 *  - Distinct from regular nodes: gradient dashed border + subtle accent wash.
 *  - Always-visible header pill (icon + name + child count) so the Frame has
 *    a clear identity even when zoomed out.
 *  - Corner brackets reinforce the "frame" metaphor.
 *  - Live progress badge during runFrame ("Running 3/7 — gen.image").
 */
function FrameNodeInner(props: NodeProps) {
  const { id, data, selected } = props;
  const d = data as NodeDataBase;
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const label = d.frameLabel || "Frame";

  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const childCount = useWorkflowStore((s) => {
    let n = 0;
    for (const node of s.nodes) if (node.parentId === id) n++;
    return n;
  });

  // How many child gen.video nodes already have a videoUrl. Drives whether
  // the "Export final video" button is enabled. Subscribed via a selector so
  // that re-computes only fire when a child video URL changes.
  const readyVideoCount = useWorkflowStore((s) => {
    let n = 0;
    for (const node of s.nodes) {
      if (node.parentId !== id) continue;
      const cd = node.data as NodeDataBase;
      if (cd.kind !== "gen.video") continue;
      if (cd.videoHdUrl || cd.videoUrl) n++;
    }
    return n;
  });
  const totalVideoChildCount = useWorkflowStore((s) => {
    let n = 0;
    for (const node of s.nodes) {
      if (node.parentId !== id) continue;
      if ((node.data as NodeDataBase).kind === "gen.video") n++;
    }
    return n;
  });
  const allVideosReady =
    totalVideoChildCount >= 2 && readyVideoCount === totalVideoChildCount;

  // Live run progress — populated by runFrame() while a run is in flight.
  const running = Boolean(d.frameRunning) || busy;
  const runIndex = typeof d.frameRunIndex === "number" ? d.frameRunIndex : 0;
  const runTotal = typeof d.frameRunTotal === "number" ? d.frameRunTotal : 0;
  const runCurrent = d.frameRunCurrentLabel;

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (running) return;
    setBusy(true);
    try {
      await runFrame(id);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadFrame = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (exporting) return;
    setExporting(true);
    try {
      // Collect every media output reachable inside this Frame. We read the
      // store snapshot directly (not a selector) because the button is only
      // clicked occasionally — no need to subscribe to every node change.
      const snapshot = useWorkflowStore.getState().nodes;
      const items: ExportItem[] = [];
      const subdir = label;
      let sceneIdx = 0;
      for (const n of snapshot) {
        if (n.parentId !== id) continue;
        const d = n.data as NodeDataBase;
        const kind = d.kind;
        // Only gen.* nodes produce downloadable outputs. Content nodes (text,
        // upload) and xforms either have no bytes or live on the same disk
        // already; skipping them keeps bulk exports clean.
        if (!(kind.startsWith("gen.") || kind === "xform.upscale.grok")) continue;

        sceneIdx += 1;
        const outs: OutputItem[] =
          d.outputs && d.outputs.length > 0
            ? d.outputs
            : d.videoUrl || d.videoHdUrl
              ? [{ videoUrl: d.videoUrl, videoHdUrl: d.videoHdUrl, mimeType: undefined }]
              : d.imageUrl
                ? [{ imageUrl: d.imageUrl, imageMediaId: d.imageMediaId, mimeType: undefined }]
                : [];

        const baseLabel = (d.label || kind.replace(/\./g, "_")).trim();
        outs.forEach((item, outIdx) => {
          const raw = item.videoHdUrl || item.videoUrl || item.imageUrl || "";
          if (!isLocalAssetUrl(raw)) return;
          const isVideo = Boolean(item.videoUrl || item.videoHdUrl);
          const ext = isVideo ? "mp4" : imageExtFromMime(item.mimeType, item.imageUrl);
          // Names follow `NN_<label>[_k].<ext>` so a sorted directory
          // listing mirrors the scene order on the canvas. `NN` is derived
          // from the Y-position of the node so visually-higher scenes
          // come first even if the user added them out of order; but we
          // approximate via the iteration counter because the full
          // ordering algorithm belongs to runFrame, not the export.
          const idxPrefix = String(sceneIdx).padStart(2, "0");
          const multi = outs.length > 1 ? `_${outIdx + 1}` : "";
          const fname = `${idxPrefix}_${sanitizeLabel(baseLabel)}${multi}.${ext}`;
          items.push({ sourceUrl: raw, filename: fname, subdir });
        });
      }

      if (items.length === 0) {
        toast.info(
          "Frame chưa có output nào để export",
          "Chạy Run Frame trước (hoặc các node con chưa sinh media).",
        );
        return;
      }

      const outcome = await exportAssets(items, {
        successLabel: `Đã export ${items.length} file từ "${label}"`,
      });
      if (outcome.needsConfig) {
        toast.info(
          "Chưa cấu hình Export folder",
          "Mở Settings → Download/Export để chỉ định thư mục.",
        );
      }
    } finally {
      setExporting(false);
    }
  };

  const handleCompose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (composing) return;

    const workflowId = useWorkflowStore.getState().activeWorkflowId;
    if (!workflowId) {
      toast.error("Chưa có workflow active", "Mở hoặc tạo workflow trước khi compose.");
      return;
    }
    const children = getFrameVideoChildren(id);
    if (children.length < 2) {
      toast.info(
        "Cần ít nhất 2 video để compose",
        "Frame phải chứa ≥ 2 node gen.video có videoUrl.",
      );
      return;
    }

    setComposing(true);
    try {
      const res = await fetch(`/api/frames/${encodeURIComponent(id)}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workflowId,
          videoUrls: children.map((c) => c.videoUrl),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
          error?: string;
        };
        toast.error("Compose thất bại", err.error || `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as {
        outputUrl: string;
        bytes: number;
        durationMs: number;
        fastPath: boolean;
      };
      const sizeMb = (data.bytes / 1024 / 1024).toFixed(1);
      toast.success(
        `Export xong (${sizeMb} MB)`,
        `${children.length} scenes · ${data.fastPath ? "fast-path" : "re-encode"} · ${Math.round(data.durationMs / 1000)}s`,
      );
      // Trigger a browser download of the concatenated file. The server
      // wrote it to `Workflows/<id>/assets/outputs/` so re-running the
      // frame or re-opening the workflow keeps the artifact around.
      const a = document.createElement("a");
      a.href = data.outputUrl;
      a.download = `${label.replace(/[^a-zA-Z0-9._-]+/g, "_") || "frame"}-final.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      toast.error("Compose thất bại", err instanceof Error ? err.message : String(err));
    } finally {
      setComposing(false);
    }
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (childCount > 0) {
      const ok = confirm(
        `Frame "${label}" có ${childCount} node bên trong. Xoá cũng sẽ xoá toàn bộ node con. Tiếp tục?`,
      );
      if (!ok) return;
    }
    removeNode(id);
  };

  const commitLabel = () => {
    const val = inputRef.current?.value.trim();
    setEditing(false);
    if (val && val !== label) updateNodeData(id, { frameLabel: val });
  };

  // Pull width/height from React Flow's reported style first, then fall back
  // to the data field (so the node renders at the correct size before the
  // measure pass completes).
  const width =
    (props.width as number | undefined) ??
    d.frameWidth ??
    600;
  const height =
    (props.height as number | undefined) ??
    d.frameHeight ??
    400;

  return (
    <div
      className="relative w-full h-full"
      style={{ width, height }}
    >
      {/* ── Border layer ──────────────────────────────────────────────────
       * A single dashed border — coloured & thickened on selection and while
       * running, so the frame is unmistakable from a regular node. We use
       * the inner div for the wash so the border can sit *on top* of the
       * accent fill without being clipped by overflow:hidden.
       */}
      <div
        className={cn(
          "absolute inset-0 rounded-2xl border-2 border-dashed transition-colors",
          running
            ? "border-pink-400/80"
            : selected
              ? "border-[color:var(--color-accent)]/80"
              : "border-violet-400/35 hover:border-violet-300/55",
        )}
      />

      {/* ── Backdrop wash ─────────────────────────────────────────────── */}
      <div
        className={cn(
          "absolute inset-[2px] rounded-2xl pointer-events-none transition-colors",
          "bg-gradient-to-br from-fuchsia-500/[0.04] via-transparent to-violet-500/[0.06]",
          selected && "from-fuchsia-500/[0.08] to-violet-500/[0.10]",
          running && "from-pink-500/10 via-fuchsia-500/[0.05] to-violet-500/10",
        )}
      />

      {/* ── Selection / running outer glow ───────────────────────────── */}
      {(selected || running) && (
        <div
          className={cn(
            "absolute -inset-px rounded-2xl pointer-events-none",
            running
              ? "shadow-[0_0_0_1px_rgba(244,114,182,0.45),0_0_30px_-6px_rgba(244,114,182,0.55)]"
              : "shadow-[0_0_0_1px_rgba(236,72,153,0.45),0_0_24px_-8px_rgba(236,72,153,0.45)]",
          )}
        />
      )}

      {/* ── Corner brackets — pure decoration that screams "frame" ──── */}
      <FrameCorner pos="tl" active={selected || running} />
      <FrameCorner pos="tr" active={selected || running} />
      <FrameCorner pos="bl" active={selected || running} />
      <FrameCorner pos="br" active={selected || running} />

      <NodeResizer
        minWidth={280}
        minHeight={180}
        isVisible={selected}
        lineClassName="!border-[color:var(--color-accent)]/60"
        handleClassName="!bg-[color:var(--color-accent)] !border-white/30"
        onResizeEnd={(_, params) => {
          updateNodeData(id, {
            frameWidth: Math.round(params.width),
            frameHeight: Math.round(params.height),
          });
        }}
      />

      {/* ── Header pill — top-left, sits on the border ──────────────── */}
      <div className="absolute -top-3.5 left-4 flex items-center gap-1.5 pointer-events-auto z-10">
        <div
          className={cn(
            "flex items-center gap-1.5 h-7 pl-1.5 pr-2 rounded-full border shadow-md backdrop-blur",
            "bg-gradient-to-r from-fuchsia-500/95 via-pink-500/95 to-rose-500/95",
            "border-white/20 text-white",
          )}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
            requestAnimationFrame(() => inputRef.current?.select());
          }}
          title="Double-click để đổi tên Frame"
        >
          <span className="h-5 w-5 rounded-full bg-white/15 grid place-items-center">
            <FrameIcon className="h-3 w-3" />
          </span>
          {editing ? (
            <input
              ref={inputRef}
              defaultValue={label}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitLabel();
                if (e.key === "Escape") setEditing(false);
                e.stopPropagation();
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="bg-white/15 outline-none rounded px-1.5 py-px text-[12px] font-semibold w-40 text-white placeholder-white/60"
            />
          ) : (
            <span className="select-none text-[12px] font-semibold tracking-wide">
              {label}
            </span>
          )}
          <span className="ml-0.5 px-1.5 py-px text-[9px] font-medium rounded-full bg-white/20 uppercase tracking-wider">
            {childCount}
          </span>
        </div>

        {/* Run progress badge — appears next to the header while running. */}
        {running && runTotal > 0 && (
          <div className="flex items-center gap-1.5 h-7 px-2 rounded-full border border-pink-400/40 bg-[color:var(--color-bg-elev-1)]/95 backdrop-blur shadow-md text-[11px] text-pink-200">
            <Loader2 className="h-3 w-3 animate-spin text-pink-300" />
            <span className="tabular-nums">
              {runIndex}/{runTotal}
            </span>
            {runCurrent && (
              <span className="max-w-[140px] truncate text-[10px] text-pink-100/80">
                · {runCurrent}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Toolbar — top-right, sits on the border ─────────────────── */}
      <div className="absolute -top-3.5 right-4 flex items-center gap-1 pointer-events-auto z-10">
        <button
          type="button"
          onClick={handleRun}
          disabled={running || childCount === 0}
          title={
            childCount === 0
              ? "Frame trống — kéo node vào trong để chạy"
              : "Run lại toàn bộ node trong Frame theo thứ tự dependency"
          }
          className={cn(
            "h-7 pl-2 pr-2.5 flex items-center gap-1.5 rounded-full border text-[11px] font-semibold shadow-md transition",
            running
              ? "border-pink-400/40 bg-[color:var(--color-bg-elev-1)]/95 text-pink-200 cursor-wait"
              : childCount === 0
                ? "border-white/10 bg-[color:var(--color-bg-elev-2)]/80 text-[color:var(--color-fg-dim)] opacity-60 cursor-not-allowed"
                : "border-white/20 bg-gradient-to-r from-fuchsia-500 to-rose-500 text-white hover:from-fuchsia-600 hover:to-rose-600",
          )}
        >
          {running ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3 fill-current" />
          )}
          {running ? "Running…" : "Run Frame"}
        </button>
        <button
          type="button"
          onClick={handleDownloadFrame}
          disabled={exporting || childCount === 0}
          title={
            childCount === 0
              ? "Frame trống — chưa có gì để download"
              : `Download toàn bộ ảnh/video trong "${label}" ra thư mục Export (Settings)`
          }
          className={cn(
            "h-7 w-7 grid place-items-center rounded-full border bg-[color:var(--color-bg-elev-1)]/90 backdrop-blur shadow-md transition",
            exporting
              ? "border-emerald-400/40 text-emerald-200 cursor-wait"
              : childCount === 0
                ? "border-white/10 text-[color:var(--color-fg-dim)] opacity-60 cursor-not-allowed"
                : "border-white/15 text-[color:var(--color-fg-muted)] hover:text-emerald-300 hover:border-emerald-500/50",
          )}
        >
          {exporting ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          onClick={handleCompose}
          disabled={composing || !allVideosReady}
          title={
            totalVideoChildCount < 2
              ? "Cần ít nhất 2 node gen.video trong Frame để ghép"
              : !allVideosReady
                ? `Một số video chưa sẵn sàng (${readyVideoCount}/${totalVideoChildCount})`
                : `Ghép ${totalVideoChildCount} video con thành 1 MP4 hoàn chỉnh (không chỉnh sửa, giữ audio gốc)`
          }
          className={cn(
            "h-7 w-7 grid place-items-center rounded-full border bg-[color:var(--color-bg-elev-1)]/90 backdrop-blur shadow-md transition",
            composing
              ? "border-sky-400/40 text-sky-200 cursor-wait"
              : !allVideosReady
                ? "border-white/10 text-[color:var(--color-fg-dim)] opacity-60 cursor-not-allowed"
                : "border-white/15 text-[color:var(--color-fg-muted)] hover:text-sky-300 hover:border-sky-500/50",
          )}
        >
          {composing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          title="Xoá Frame (và tất cả node con)"
          className="h-7 w-7 grid place-items-center rounded-full border border-white/15 bg-[color:var(--color-bg-elev-1)]/90 backdrop-blur shadow-md text-[color:var(--color-fg-muted)] hover:text-red-300 hover:border-red-500/50"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* ── Footer hint — bottom-left, only when frame is empty ──────── */}
      {childCount === 0 && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="flex flex-col items-center gap-1.5 text-[color:var(--color-fg-dim)]">
            <FrameIcon className="h-7 w-7 opacity-40" />
            <div className="text-[11px] font-medium">Kéo node vào đây</div>
            <div className="text-[10px] opacity-70">
              Bấm <span className="text-pink-300 font-semibold">Run Frame</span> để chạy
              toàn bộ theo dependency
            </div>
          </div>
        </div>
      )}

      {/* ── "All done" tick badge after a successful run, bottom-right ── */}
      {!running && d.frameRunIndex === undefined && childCount > 0 && (
        <FrameDoneBadge frameId={id} />
      )}
    </div>
  );
}

export default React.memo(FrameNodeInner);

/**
 * Subtle bracket marker in each corner — purely cosmetic, drawn with two
 * absolutely-positioned border segments so it doesn't interfere with the
 * resizer handles. Mirrored automatically per corner.
 */
function FrameCorner({
  pos,
  active,
}: {
  pos: "tl" | "tr" | "bl" | "br";
  active?: boolean;
}) {
  const sides: Record<typeof pos, string> = {
    tl: "top-1.5 left-1.5 border-t-2 border-l-2 rounded-tl-md",
    tr: "top-1.5 right-1.5 border-t-2 border-r-2 rounded-tr-md",
    bl: "bottom-1.5 left-1.5 border-b-2 border-l-2 rounded-bl-md",
    br: "bottom-1.5 right-1.5 border-b-2 border-r-2 rounded-br-md",
  };
  return (
    <div
      className={cn(
        "absolute h-3 w-3 pointer-events-none transition-colors",
        sides[pos],
        active ? "border-[color:var(--color-accent)]" : "border-violet-300/50",
      )}
    />
  );
}

/**
 * Reads the children's status from the store and shows a small tick when ALL
 * non-content children are `done`. Lives in its own component so the parent
 * doesn't re-render every progress tick.
 */
/** Strip filesystem-unsafe characters from a node label. Mirrors the
 *  server-side sanitizer so names round-trip; we still sanitize here so
 *  toasts that echo the path are honest about what hit disk. */
function sanitizeLabel(label: string): string {
  return label.replace(/[\\/:*?"<>|\r\n\t]+/g, "_").trim().slice(0, 120) || "scene";
}

/** Best-effort extension inference for images. Kept tiny and dependency-free
 *  — prefer mimeType, fall back to URL suffix, default png. Video nodes
 *  always emit mp4 so this is image-only. */
function imageExtFromMime(mime?: string, url?: string): string {
  if (mime) {
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
  }
  if (url) {
    const m = url.toLowerCase().match(/\.(png|jpe?g|webp|gif)(?:\?|$)/);
    if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  }
  return "png";
}

function FrameDoneBadge({ frameId }: { frameId: string }) {
  const allDone = useWorkflowStore((s) => {
    let any = false;
    for (const n of s.nodes) {
      if (n.parentId !== frameId) continue;
      const k = (n.data as NodeDataBase).kind;
      if (k.startsWith("content.") || k === "frame") continue;
      any = true;
      if ((n.data as NodeDataBase).status !== "done") return false;
    }
    return any;
  });
  if (!allDone) return null;
  return (
    <div className="absolute -bottom-3 right-4 flex items-center gap-1 h-6 px-2 rounded-full border border-emerald-500/40 bg-[color:var(--color-bg-elev-1)]/95 backdrop-blur shadow-md text-[10px] font-semibold text-emerald-300 pointer-events-none z-10">
      <CheckCircle2 className="h-3 w-3" />
      All done
    </div>
  );
}
