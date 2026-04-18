"use client";

import { useLiveQuery } from "dexie-react-hooks";
import {
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  XCircle,
  Trash2,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { db, type WorkflowRecord } from "@/lib/db";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/state/workflowStore";

interface AuthStatus {
  veo: { ok: boolean };
  grok: { ok: boolean };
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Context menu (appears on "..." click)
// ---------------------------------------------------------------------------
function CardMenu({
  wf,
  onClose,
}: {
  wf: WorkflowRecord;
  onClose: () => void;
}) {
  const { deleteWorkflow, duplicateWorkflow, renameWorkflow } = useWorkflowStore();

  const handleRename = async () => {
    onClose();
    const name = prompt("Rename workflow:", wf.name);
    if (name && name !== wf.name) await renameWorkflow(wf.id, name);
  };

  const handleDuplicate = async () => {
    onClose();
    await duplicateWorkflow(wf.id);
  };

  const handleDelete = async () => {
    onClose();
    if (!confirm(`Delete "${wf.name}"? This cannot be undone.`)) return;
    await deleteWorkflow(wf.id);
  };

  return (
    <div className="absolute right-2 top-10 z-50 w-40 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)] py-1 shadow-xl">
      <MenuBtn icon={<Pencil className="h-3.5 w-3.5" />} onClick={handleRename}>
        Rename
      </MenuBtn>
      <MenuBtn icon={<Copy className="h-3.5 w-3.5" />} onClick={handleDuplicate}>
        Duplicate
      </MenuBtn>
      <div className="my-1 border-t border-[color:var(--color-border)]" />
      <MenuBtn
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={handleDelete}
        className="text-red-400 hover:text-red-300"
      >
        Delete
      </MenuBtn>
    </div>
  );
}

function MenuBtn({
  icon,
  onClick,
  children,
  className,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-1)] hover:text-[color:var(--color-fg)] transition",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Workflow Card
// ---------------------------------------------------------------------------
function WorkflowCard({ wf }: { wf: WorkflowRecord }) {
  const { loadWorkflow } = useWorkflowStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const nodeCount = wf.data.nodes?.length ?? 0;

  const handleOpen = useCallback(() => {
    void loadWorkflow(wf.id);
  }, [wf.id, loadWorkflow]);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={handleOpen}
        className="w-full text-left rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-1)] hover:border-[color:var(--color-accent)]/50 hover:bg-[color:var(--color-bg-elev-2)] transition overflow-hidden"
      >
        {/* Thumbnail area */}
        <div className="h-32 bg-gradient-to-br from-[color:var(--color-bg-elev-2)] to-[color:var(--color-bg)] flex items-center justify-center">
          <Workflow className="h-10 w-10 text-[color:var(--color-fg-dim)]/30" />
        </div>
        {/* Info */}
        <div className="p-3">
          <h3 className="text-sm font-medium text-[color:var(--color-fg)] truncate">
            {wf.name}
          </h3>
          <div className="mt-1.5 flex items-center gap-3 text-[10px] text-[color:var(--color-fg-dim)]">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {relativeTime(wf.updatedAt)}
            </span>
            <span>{nodeCount} node{nodeCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </button>

      {/* "..." menu trigger */}
      <div ref={menuRef}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={cn(
            "absolute right-2 top-2 h-7 w-7 rounded-md grid place-items-center transition",
            "bg-[color:var(--color-bg-elev-2)]/80 border border-[color:var(--color-border)]",
            "opacity-0 group-hover:opacity-100",
            menuOpen && "opacity-100",
            "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]",
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <CardMenu wf={wf} onClose={() => setMenuOpen(false)} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New Workflow Card
// ---------------------------------------------------------------------------
function NewWorkflowCard() {
  const { createWorkflow } = useWorkflowStore();

  const handleCreate = useCallback(() => {
    void createWorkflow();
  }, [createWorkflow]);

  return (
    <button
      type="button"
      onClick={handleCreate}
      className="flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-[color:var(--color-border)] hover:border-[color:var(--color-accent)]/50 bg-[color:var(--color-bg-elev-1)]/50 hover:bg-[color:var(--color-bg-elev-2)] transition min-h-[196px]"
    >
      <div className="h-12 w-12 rounded-full bg-[color:var(--color-accent)]/10 grid place-items-center">
        <Plus className="h-6 w-6 text-[color:var(--color-accent)]" />
      </div>
      <span className="text-sm font-medium text-[color:var(--color-fg-muted)]">
        New Workflow
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
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
    await fetch(`/api/test/${target}`, { method: "POST" });
  } catch { /* ignore */ }
  onDone();
}

function DashboardProviderBadge({
  label,
  ok,
  onLogin,
}: {
  label: string;
  ok: boolean;
  onLogin?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (ok || !onLogin) return;
    setBusy(true);
    try {
      await onLogin();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || ok}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 cursor-default"
          : "border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:border-[color:var(--color-accent)]/50 hover:text-zinc-300 cursor-pointer",
      )}
      title={ok ? `${label}: Sẵn sàng tạo` : `${label}: Chưa đăng nhập — click để login`}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : ok ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <XCircle className="h-3.5 w-3.5" />
      )}
      {label}
      <span className={cn("text-[10px]", ok ? "text-emerald-500/70" : "text-zinc-600")}>
        {ok ? "Ready" : "Click to login"}
      </span>
    </button>
  );
}

export default function WorkflowDashboard() {
  const workflows = useLiveQuery(() =>
    db().workflows.orderBy("updatedAt").reverse().toArray(),
  );

  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const refreshAuth = useCallback(() => {
    fetch("/api/auth/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: AuthStatus) => setAuth(d))
      .catch(() => setAuth(null));
  }, []);
  useEffect(() => { refreshAuth(); }, [refreshAuth]);

  return (
    <div className="h-screen w-screen overflow-auto bg-[color:var(--color-bg)]">
      {/* Header */}
      <div className="mx-auto max-w-5xl px-6 pt-16 pb-8">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-pink-500 to-purple-600 grid place-items-center">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[color:var(--color-fg)]">
                Workflow Space Ultra
              </h1>
              <p className="text-xs text-[color:var(--color-fg-dim)]">
                Select a workflow to edit, or create a new one
              </p>
            </div>
          </div>
          {auth && (
            <div className="flex items-center gap-2">
              <DashboardProviderBadge
                label="VEO"
                ok={auth.veo.ok}
                onLogin={() => openAndVerify("veo", refreshAuth)}
              />
              <DashboardProviderBadge
                label="Grok"
                ok={auth.grok.ok}
                onLogin={() => openAndVerify("grok", refreshAuth)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="mx-auto max-w-5xl px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          <NewWorkflowCard />
          {workflows?.map((wf) => (
            <WorkflowCard key={wf.id} wf={wf} />
          ))}
        </div>

        {workflows && workflows.length === 0 && (
          <p className="mt-8 text-center text-sm text-[color:var(--color-fg-dim)]">
            No workflows yet. Click &quot;New Workflow&quot; to get started.
          </p>
        )}
      </div>
    </div>
  );
}
