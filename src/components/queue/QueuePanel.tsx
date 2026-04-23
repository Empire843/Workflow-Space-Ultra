"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pause,
  RefreshCcw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { NodeKind } from "@/lib/nodes";
import { useWorkflowStore } from "@/state/workflowStore";

/**
 * Server-side job record shape (mirrors `JobRecord` in `src/server/queue.ts`).
 * Kept local so the client bundle doesn't import server code.
 */
interface ApiJob {
  id: string;
  nodeId: string;
  kind: NodeKind;
  status: "queued" | "running" | "done" | "error" | "cancelled";
  progress: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  cancelRequested?: boolean;
}

interface ApiLane {
  concurrency: number;
  active: number;
  queued: number;
}

interface QueueSnapshot {
  ok: boolean;
  lanes: Record<string, ApiLane>;
  jobs: ApiJob[];
  now: number;
}

/**
 * Queue panel — slide-in drawer mirroring `GET /api/queue`.
 *
 * Layout notes:
 *   - `h-screen` is required on the aside (not `top/bottom-0`) because some
 *     fixed-positioned flex children still collapse their height unless it's
 *     stated explicitly.
 *   - The scrollable middle section MUST use `flex-1 min-h-0` to override the
 *     default `min-height: auto` which otherwise sizes it to its intrinsic
 *     content height → the footer would stick right under the last rendered
 *     section instead of the bottom of the viewport (the bug in the first cut
 *     of this panel).
 */
export default function QueuePanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const nodes = useWorkflowStore((s) => s.nodes);
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  const nodeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes) map.set(n.id, n.data.label || n.data.kind);
    return map;
  }, [nodes]);

  const fetchSnapshot = useCallback(async () => {
    try {
      const r = await fetch("/api/queue", { cache: "no-store" });
      const body = (await r.json()) as QueueSnapshot;
      if (!body.lanes) throw new Error("Invalid format: missing lanes");
      setSnapshot(body);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(String(err));
      // keep last snapshot; show stale but don't crash the panel
    } finally {
      setLoading(false);
    }
  }, []);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!open) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    setLoading(true);
    void fetchSnapshot();
    pollRef.current = setInterval(fetchSnapshot, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [open, fetchSnapshot]);

  const cancelJob = useCallback(
    async (jobId: string, nodeId?: string) => {
      setBusyAction(`cancel:${jobId}`);
      try {
        await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
        if (nodeId) {
          updateNodeData(nodeId, { status: "error", error: "Cancelled" });
        }
        await fetchSnapshot();
      } finally {
        setBusyAction(null);
      }
    },
    [fetchSnapshot, updateNodeData],
  );

  const cancelAll = useCallback(async () => {
    if (!confirm("Cancel tất cả job trong queue + running?")) return;
    setBusyAction("cancelAll");
    try {
      await fetch("/api/queue", { method: "DELETE" });
      await fetchSnapshot();
    } finally {
      setBusyAction(null);
    }
  }, [fetchSnapshot]);

  const clearFinished = useCallback(async () => {
    setBusyAction("clearFinished");
    try {
      await fetch("/api/queue?clearFinished=1", { method: "DELETE" });
      await fetchSnapshot();
    } finally {
      setBusyAction(null);
    }
  }, [fetchSnapshot]);

  const forceReset = useCallback(async () => {
    if (
      !confirm(
        "Force reset lanes? Dùng khi lane counter bị kẹt active≥1 mà không có job nào đang chạy thực sự.",
      )
    )
      return;
    setBusyAction("reset");
    try {
      await fetch("/api/queue?reset=1", { method: "DELETE" });
      await fetchSnapshot();
    } finally {
      setBusyAction(null);
    }
  }, [fetchSnapshot]);

  if (!open) return null;

  const jobs = snapshot?.jobs ?? [];
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const finished = jobs.filter(
    (j) => j.status === "done" || j.status === "error" || j.status === "cancelled",
  );

  const hasActionable = running.length > 0 || queued.length > 0;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-screen w-[420px] max-w-[94vw]",
          "bg-[color:var(--color-bg-elev-1)] border-l border-[color:var(--color-border)]",
          "shadow-2xl flex flex-col",
        )}
        role="dialog"
        aria-label="Job queue"
      >
        <header className="h-12 px-4 border-b border-[color:var(--color-border)] flex items-center gap-2 shrink-0">
          <h2 className="text-sm font-semibold flex-1 text-[color:var(--color-fg)]">
            Queue
            {hasActionable && (
              <span className="ml-2 text-[11px] font-normal text-[color:var(--color-fg-muted)]">
                {running.length} running · {queued.length} queued
              </span>
            )}
          </h2>
          {errorMsg && (
            <span className="text-[10px] text-red-400 font-mono truncate max-w-[150px] mr-2" title={errorMsg}>
              {errorMsg}
            </span>
          )}
          {loading && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[color:var(--color-fg-muted)]" />
          )}
          <button
            type="button"
            onClick={fetchSnapshot}
            title="Refresh"
            className="h-7 w-7 grid place-items-center rounded-md hover:bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)]"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="h-7 w-7 grid place-items-center rounded-md hover:bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
          <LaneBar lanes={snapshot?.lanes} />

          <JobSection
            title="Running"
            count={running.length}
            icon={<Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />}
            jobs={running}
            nodeLabels={nodeLabels}
            busyAction={busyAction}
            onCancel={cancelJob}
            emptyText="Không có job nào đang chạy."
          />

          <JobSection
            title="Queued"
            count={queued.length}
            icon={<Pause className="h-3.5 w-3.5 text-amber-400" />}
            jobs={queued}
            nodeLabels={nodeLabels}
            busyAction={busyAction}
            onCancel={cancelJob}
            emptyText="Queue trống."
          />

          <JobSection
            title="Recently finished"
            count={finished.length}
            icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
            jobs={finished.slice(0, 20)}
            nodeLabels={nodeLabels}
            busyAction={busyAction}
            emptyText="Chưa có job nào hoàn thành."
            finishedMode
          />
        </div>

        <footer className="border-t border-[color:var(--color-border)] p-3 flex flex-col gap-2 shrink-0 bg-[color:var(--color-bg-elev-1)]">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={cancelAll}
              disabled={busyAction === "cancelAll" || !hasActionable}
              className={cn(
                "flex-1 h-8 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5",
                "bg-amber-500/10 border border-amber-500/30 text-amber-300",
                "hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {busyAction === "cancelAll" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Cancel all
            </button>
            <button
              type="button"
              onClick={clearFinished}
              disabled={busyAction === "clearFinished" || finished.length === 0}
              className={cn(
                "flex-1 h-8 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5",
                "bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]",
                "hover:text-[color:var(--color-fg)] disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {busyAction === "clearFinished" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Clear finished
            </button>
          </div>
          <button
            type="button"
            onClick={forceReset}
            disabled={busyAction === "reset"}
            className={cn(
              "h-8 px-3 rounded-md text-xs font-medium flex items-center justify-center gap-1.5",
              "border border-red-500/30 bg-red-500/10 text-red-300",
              "hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            {busyAction === "reset" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" />
            )}
            Force reset lanes (last resort)
          </button>
        </footer>
      </aside>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*                                  Sections                                  */
/* -------------------------------------------------------------------------- */

/**
 * Always renders — when `lanes` is undefined (first fetch in flight) we show a
 * skeleton so the user sees "loading", not a blank area.
 */
function LaneBar({ lanes }: { lanes?: Record<string, ApiLane> }) {
  const entries = lanes ? Object.entries(lanes) : [];
  return (
    <div className="rounded-lg bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-fg-muted)] mb-1.5">
        Lanes
      </div>
      {entries.length === 0 ? (
        <div className="grid grid-cols-2 gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[22px] rounded bg-[color:var(--color-bg)] border border-[color:var(--color-border)] animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {entries.map(([key, lane]) => (
            <div
              key={key}
              className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-[color:var(--color-bg)] border border-[color:var(--color-border)]"
            >
              <span className="font-mono text-[color:var(--color-fg)]">{key}</span>
              <span className="text-[color:var(--color-fg-muted)]">
                <span
                  className={cn(
                    "font-semibold",
                    lane.active > 0 ? "text-blue-400" : "text-[color:var(--color-fg)]",
                  )}
                >
                  {lane.active}
                </span>
                /{lane.concurrency}
                {lane.queued > 0 && (
                  <span className="ml-1 text-amber-400">(+{lane.queued})</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobSection({
  title,
  count,
  icon,
  jobs,
  nodeLabels,
  busyAction,
  onCancel,
  emptyText,
  finishedMode,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  jobs: ApiJob[];
  nodeLabels: Map<string, string>;
  busyAction: string | null;
  onCancel?: (jobId: string, nodeId?: string) => void;
  emptyText?: string;
  finishedMode?: boolean;
}) {
  return (
    <section>
      <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5 flex items-center gap-1.5 text-[color:var(--color-fg)]">
        {icon}
        <span>{title}</span>
        <span className="text-[color:var(--color-fg-muted)] font-normal">({count})</span>
      </div>
      {jobs.length === 0 ? (
        emptyText ? (
          <div className="text-[11px] text-[color:var(--color-fg-dim)] px-2 py-1.5 rounded bg-[color:var(--color-bg)]/40 border border-dashed border-[color:var(--color-border)]">
            {emptyText}
          </div>
        ) : null
      ) : (
        <div className="space-y-1">
          {jobs.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              label={nodeLabels.get(j.nodeId) || j.nodeId}
              busy={busyAction === `cancel:${j.id}`}
              onCancel={onCancel}
              finishedMode={finishedMode}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function JobRow({
  job,
  label,
  busy,
  onCancel,
  finishedMode,
}: {
  job: ApiJob;
  label: string;
  busy: boolean;
  onCancel?: (jobId: string, nodeId?: string) => void;
  finishedMode?: boolean;
}) {
  const statusColor =
    job.status === "running"
      ? "text-blue-400"
      : job.status === "queued"
        ? "text-amber-400"
        : job.status === "done"
          ? "text-emerald-400"
          : "text-red-400";

  const elapsed =
    job.status === "running" && job.startedAt
      ? Math.round((Date.now() - job.startedAt) / 1000)
      : job.finishedAt && job.startedAt
        ? Math.round((job.finishedAt - job.startedAt) / 1000)
        : null;

  return (
    <div className="flex items-center gap-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] px-2.5 py-1.5 text-[11px]">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 truncate">
          <span className={cn("font-mono text-[10px] font-bold shrink-0", statusColor)}>
            {job.status.toUpperCase()}
          </span>
          <span className="truncate font-medium text-[color:var(--color-fg)]">{label}</span>
        </div>
        <div className="text-[10px] text-[color:var(--color-fg-muted)] font-mono truncate mt-0.5">
          <span>{job.kind}</span>
          {job.status === "running" && <span> · {job.progress}%</span>}
          {elapsed !== null && <span> · {elapsed}s</span>}
          {job.cancelRequested && !finishedMode && (
            <span className="text-amber-400"> · cancelling…</span>
          )}
        </div>
        {job.error && (
          <div className="text-[10px] text-red-300 truncate mt-0.5" title={job.error}>
            {job.error}
          </div>
        )}
      </div>
      {!finishedMode && onCancel && (job.status === "running" || job.status === "queued") && (
        <button
          type="button"
          onClick={() => onCancel(job.id, job.nodeId)}
          disabled={busy || job.cancelRequested}
          title="Cancel this job"
          className={cn(
            "h-6 w-6 shrink-0 grid place-items-center rounded",
            "text-[color:var(--color-fg-muted)] hover:text-red-300 hover:bg-red-500/10",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}
