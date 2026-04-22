"use client";

import {
  ArrowLeft,
  CheckCircle2,
  Download,
  ListOrdered,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  Settings,
  Undo2,
  Redo2,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { useWorkflowStore } from "@/state/workflowStore";

import QueuePanel from "../queue/QueuePanel";
import SettingsDialog from "../settings/SettingsDialog";

interface LaneStats {
  concurrency: number;
  active: number;
  queued: number;
}

type AuthStatusKind = "fresh" | "stale" | "expired";

interface AuthSlice {
  ok: boolean;
  status: AuthStatusKind;
  ageMs: number | null;
  updatedAt: string | null;
  chromeConnected: boolean;
  /**
   * Optional reason returned by `computeVeoHealth` / `computeGrokHealth`.
   * Currently we only react to `"chrome-disconnected"` to swap the badge
   * tooltip; everything else is purely informational telemetry.
   */
  reason?: string;
}

interface AuthStatus {
  veo: AuthSlice & { projectId: string | null };
  grok: AuthSlice & { profileName: string };
}

export default function TopBar() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueBadge, setQueueBadge] = useState<{ running: number; queued: number } | null>(null);

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [prewarming, setPrewarming] = useState<{ veo: boolean; grok: boolean }>({
    veo: false,
    grok: false,
  });

  const activeWorkflowName = useWorkflowStore((s) => s.activeWorkflowName);
  const goToDashboard = useWorkflowStore((s) => s.goToDashboard);
  const renameWorkflow = useWorkflowStore((s) => s.renameWorkflow);
  const activeWorkflowId = useWorkflowStore((s) => s.activeWorkflowId);
  const saveCurrent = useWorkflowStore((s) => s._saveCurrentWorkflow);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const canUndo = useWorkflowStore((s) => s.canUndo);
  const canRedo = useWorkflowStore((s) => s.canRedo);

  const refreshAuth = useCallback(
    () =>
      fetch("/api/auth/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d: AuthStatus) => setAuth(d))
        .catch(() => setAuth(null)),
    [],
  );

  useEffect(() => {
    refreshAuth();
  }, [refreshAuth]);

  // Background poll every 60s so the amber "stale" state surfaces without
  // requiring the user to reload. The previous one-shot fetch meant the
  // badge stayed green for hours even after the token actually expired.
  useEffect(() => {
    const id = setInterval(() => {
      refreshAuth();
    }, 60_000);
    return () => clearInterval(id);
  }, [refreshAuth]);

  /**
   * Light-weight poller for the queue badge. Only runs while the panel is closed
   * (open = the panel owns its own 2s poll). 5s cadence is plenty to surface a
   * "jobs are piling up" indicator without hammering the API.
   */
  useEffect(() => {
    if (queueOpen) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/queue", { cache: "no-store" });
        const body = (await r.json()) as {
          ok: boolean;
          jobs: { status: string }[];
          lanes: Record<string, LaneStats>;
        };
        if (!alive || !body.ok) return;
        const running = body.jobs.filter((j) => j.status === "running").length;
        const queued = body.jobs.filter((j) => j.status === "queued").length;
        setQueueBadge(running + queued > 0 ? { running, queued } : null);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [queueOpen]);

  const handleLogout = async (target: "veo" | "grok") => {
    const label = target.toUpperCase();
    const proceed = confirm(
      `Đăng xuất ${label} sẽ XOÁ TOÀN BỘ cookies / cache / profile của ${label}.\n\n` +
        `Chrome ${label} sẽ bị tắt và lần sau bạn phải đăng nhập lại từ đầu.\n\nTiếp tục?`,
    );
    if (!proceed) return;
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    await refreshAuth();
  };

  const triggerPrewarm = useCallback(
    async (targets: Array<"veo" | "grok">) => {
      if (targets.length === 0) return;
      setPrewarming((prev) => {
        const next = { ...prev };
        for (const t of targets) next[t] = true;
        return next;
      });
      try {
        await fetch("/api/auth/prewarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets }),
        }).catch(() => null);
      } finally {
        // Give the server a couple seconds to write the new cache before
        // we poll — otherwise the badge flaps amber→amber even though the
        // background refresh already succeeded.
        setTimeout(() => {
          setPrewarming((prev) => {
            const next = { ...prev };
            for (const t of targets) next[t] = false;
            return next;
          });
          void refreshAuth();
        }, 2500);
      }
    },
    [refreshAuth],
  );

  // Auto pre-warm stale providers: runs whenever the polled status flips
  // to "stale". We deliberately no longer gate on `chromeConnected` — when
  // the singleton has just been wiped (server restart, HMR, user closed
  // Chrome) the prewarm endpoint is exactly the thing that re-attaches it,
  // so requiring it here would deadlock the badge in amber forever. If the
  // user has actually logged out, the next status poll will flip us to
  // `expired` and we won't loop.
  useEffect(() => {
    if (!auth) return;
    const targets: Array<"veo" | "grok"> = [];
    if (auth.veo.status === "stale" && !prewarming.veo) {
      targets.push("veo");
    }
    if (auth.grok.status === "stale" && !prewarming.grok) {
      targets.push("grok");
    }
    if (targets.length > 0) void triggerPrewarm(targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.veo.status, auth?.grok.status]);



  const handleSave = useCallback(async () => {
    await saveCurrent();
  }, [saveCurrent]);

  const handleExport = useCallback(() => {
    const { nodes, edges, activeWorkflowName: name } = useWorkflowStore.getState();
    const data = JSON.stringify({ name, nodes, edges }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(name || "workflow").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleBack = useCallback(async () => {
    await goToDashboard();
  }, [goToDashboard]);

  return (
    <div className="absolute top-0 left-0 right-0 z-30 h-12 bg-[color:var(--color-bg-elev-1)]/80 backdrop-blur border-b border-[color:var(--color-border)] flex items-center px-3 gap-2">
      {/* Back to dashboard */}
      <TopBarButton
        icon={<ArrowLeft className="h-4 w-4" />}
        label="Back to Dashboard"
        onClick={handleBack}
      />

      <div className="flex items-center gap-2">
        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-pink-500 to-purple-600 grid place-items-center text-white text-sm font-semibold">
          W
        </div>
        <WorkflowNameEditor
          name={activeWorkflowName}
          workflowId={activeWorkflowId}
          onRename={renameWorkflow}
        />
        <span className="px-1.5 py-0.5 text-[10px] rounded bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)] border border-[color:var(--color-border)]">
          Beta
        </span>
      </div>

      <div className="mx-4 h-6 w-px bg-[color:var(--color-border)]" />

      <TopBarButton
        icon={<Undo2 className="h-4 w-4" />}
        label="Undo (Ctrl+Z)"
        onClick={undo}
        disabled={!canUndo}
      />
      <TopBarButton
        icon={<Redo2 className="h-4 w-4" />}
        label="Redo (Ctrl+Shift+Z)"
        onClick={redo}
        disabled={!canRedo}
      />

      <div className="flex-1" />

      {auth ? (
        <div className="flex items-center gap-1.5">
          <ProviderBadge
            label="VEO"
            target="veo"
            status={auth.veo.status}
            ageMs={auth.veo.ageMs}
            reason={auth.veo.reason}
            prewarming={prewarming.veo}
            onLogin={() => openAndVerify("veo", refreshAuth)}
            onLogout={() => handleLogout("veo")}
          />
          <ProviderBadge
            label="Grok"
            target="grok"
            status={auth.grok.status}
            ageMs={auth.grok.ageMs}
            reason={auth.grok.reason}
            prewarming={prewarming.grok}
            onLogin={() => openAndVerify("grok", refreshAuth)}
            onLogout={() => handleLogout("grok")}
          />
        </div>
      ) : null}

      <button
        type="button"
        onClick={handleSave}
        className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-elev-1)] text-[color:var(--color-fg-muted)] text-xs flex items-center gap-1.5"
      >
        <Save className="h-3.5 w-3.5" /> Save
      </button>
      <button
        type="button"
        onClick={handleExport}
        className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-elev-1)] text-[color:var(--color-fg-muted)] text-xs flex items-center gap-1.5"
      >
        <Download className="h-3.5 w-3.5" /> Export
      </button>
      <button
        type="button"
        onClick={() => setQueueOpen(true)}
        title="Xem queue, cancel job, reset lanes"
        className={cn(
          "relative h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border hover:bg-[color:var(--color-bg-elev-1)] text-xs flex items-center gap-1.5",
          queueBadge
            ? "border-amber-500/40 text-amber-300"
            : "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]",
        )}
      >
        <ListOrdered className="h-3.5 w-3.5" /> Queue
        {queueBadge && (
          <span className="ml-0.5 inline-flex items-center gap-0.5 text-[10px] font-semibold">
            {queueBadge.running > 0 && <span className="text-blue-300">{queueBadge.running}</span>}
            {queueBadge.queued > 0 && (
              <span className="text-amber-300">
                {queueBadge.running > 0 ? "+" : ""}
                {queueBadge.queued}
              </span>
            )}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="h-8 px-3 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-elev-1)] text-[color:var(--color-fg-muted)] text-xs flex items-center gap-1.5"
      >
        <Settings className="h-3.5 w-3.5" /> Settings
      </button>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider auth badge — click to login when not connected
// ---------------------------------------------------------------------------
async function openAndVerify(target: "veo" | "grok", onDone: () => void) {
  try {
    const openRes = await fetch("/api/chrome/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const openData = (await openRes.json()) as { ok: boolean; message?: string };
    if (!openData.ok) {
      alert(`Mở Chrome ${target.toUpperCase()} thất bại: ${openData.message || "unknown"}`);
      return;
    }
    alert(
      target === "veo"
        ? "Chrome VEO đã mở.\n\n1. Đăng nhập Google (nếu chưa)\n2. Vào labs.google/fx/tools/flow → mở project\n3. Quay lại đây, badge sẽ tự cập nhật."
        : "Chrome Grok đã mở.\n\n1. Đăng nhập tài khoản Super Grok\n2. Vào grok.com/imagine, thử tạo 1 prompt\n3. Quay lại đây, badge sẽ tự cập nhật.",
    );
    // Auto-verify after user comes back
    await fetch(`/api/test/${target}`, { method: "POST" });
  } catch { /* ignore */ }
  onDone();
}

function formatAgeShort(ageMs: number | null): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${hr}h${rem}m` : `${hr}h`;
}

function ProviderBadge({
  label,
  target,
  status,
  ageMs,
  reason,
  prewarming,
  onLogin,
  onLogout,
}: {
  label: string;
  target: "veo" | "grok";
  status: AuthStatusKind;
  ageMs: number | null;
  reason?: string;
  prewarming?: boolean;
  onLogin?: () => void;
  onLogout?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const ok = status !== "expired";

  const handleBadgeClick = async () => {
    if (ok || !onLogin || busy) return;
    setBusy(true);
    try {
      await onLogin();
    } finally {
      setBusy(false);
    }
  };

  const handleLogoutClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onLogout || loggingOut) return;
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  };

  const ageLabel = formatAgeShort(ageMs);
  const title = (() => {
    switch (status) {
      case "fresh":
        return `${label}: Sẵn sàng tạo${ageLabel ? ` (cache ${ageLabel})` : ""} — hover để logout`;
      case "stale":
        if (reason === "chrome-disconnected") {
          return `${label}: Chrome đang reconnect…${ageLabel ? ` (cache ${ageLabel})` : ""}`;
        }
        return `${label}: Cache sắp hết hạn${ageLabel ? ` (${ageLabel})` : ""} — đang tự làm mới…`;
      default:
        return `${label}: Chưa đăng nhập — click để login`;
    }
  })();

  const palette = (() => {
    if (status === "fresh") {
      return {
        wrap: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
        iconColor: "text-emerald-400",
        logoutIdle: "text-emerald-400/70",
      } as const;
    }
    if (status === "stale") {
      return {
        wrap: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        iconColor: "text-amber-300",
        logoutIdle: "text-amber-300/80",
      } as const;
    }
    return {
      wrap: "border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:border-[color:var(--color-accent)]/50 hover:text-zinc-300",
      iconColor: "text-zinc-500",
      logoutIdle: "text-zinc-400",
    } as const;
  })();

  return (
    <div
      className={cn(
        "group/badge relative flex items-center gap-1 h-7 pl-2 rounded-md border text-[11px] font-medium transition",
        palette.wrap,
        ok ? "pr-1" : "pr-2",
      )}
      title={title}
    >
      <button
        type="button"
        onClick={handleBadgeClick}
        disabled={busy}
        aria-label={
          status === "fresh"
            ? `${label} logged in`
            : status === "stale"
              ? `${label} session refreshing`
              : `Login ${label}`
        }
        className={cn(
          "flex items-center gap-1 h-full focus:outline-none",
          !ok && "cursor-pointer",
        )}
      >
        {busy || prewarming ? (
          <Loader2 className={cn("h-3 w-3 animate-spin", palette.iconColor)} />
        ) : status === "fresh" ? (
          <CheckCircle2 className="h-3 w-3" />
        ) : status === "stale" ? (
          <RefreshCw className="h-3 w-3" />
        ) : (
          <XCircle className="h-3 w-3" />
        )}
        <span>{label}</span>
        {status === "stale" && (
          <span className="text-[9px] uppercase tracking-wide opacity-75">
            {prewarming ? "refreshing" : "refresh soon"}
          </span>
        )}
      </button>
      {ok && onLogout && (
        <button
          type="button"
          data-target={target}
          onClick={handleLogoutClick}
          disabled={loggingOut}
          title={`Logout ${label}`}
          aria-label={`Logout ${label}`}
          className={cn(
            "ml-0.5 h-5 w-5 grid place-items-center rounded transition",
            palette.logoutIdle,
            "opacity-0 group-hover/badge:opacity-100 focus-visible:opacity-100",
            "hover:bg-white/10 hover:text-white",
          )}
        >
          {loggingOut ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <LogOut className="h-3 w-3" />
          )}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editable workflow name
// ---------------------------------------------------------------------------
function WorkflowNameEditor({
  name,
  workflowId,
  onRename,
}: {
  name: string;
  workflowId: string | null;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = () => {
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commit = () => {
    setEditing(false);
    const val = inputRef.current?.value.trim();
    if (val && val !== name && workflowId) {
      void onRename(workflowId, val);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        defaultValue={name}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="text-sm font-semibold tracking-wide bg-transparent border-b border-[color:var(--color-accent)] outline-none text-[color:var(--color-fg)] w-48"
      />
    );
  }

  return (
    <span
      onDoubleClick={handleDoubleClick}
      title="Double-click to rename"
      className="text-sm font-semibold tracking-wide cursor-pointer hover:text-[color:var(--color-accent)] transition"
    >
      {name || "Untitled"}
    </span>
  );
}

function TopBarButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-8 w-8 grid place-items-center rounded-md text-[color:var(--color-fg-muted)] transition",
        disabled
          ? "opacity-40 cursor-not-allowed"
          : "hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]",
      )}
    >
      {icon}
    </button>
  );
}

export function RunBadge() {
  return (
    <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[color:var(--color-accent-subtle)] text-[color:var(--color-accent)] text-[10px]">
      <Zap className="h-3 w-3" />
      running
    </div>
  );
}
