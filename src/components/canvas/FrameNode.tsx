"use client";

import {
  NodeResizer,
  type NodeProps,
} from "@xyflow/react";
import {
  CheckCircle2,
  Frame as FrameIcon,
  Loader2,
  Play,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import type { NodeDataBase } from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { runFrame } from "@/state/runWorkflow";
import { useWorkflowStore } from "@/state/workflowStore";

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
export default function FrameNode(props: NodeProps) {
  const { id, data, selected } = props;
  const d = data as NodeDataBase;
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const label = d.frameLabel || "Frame";

  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const childCount = useWorkflowStore((s) => {
    let n = 0;
    for (const node of s.nodes) if (node.parentId === id) n++;
    return n;
  });

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
