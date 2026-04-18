"use client";

import { CheckCircle2, ExternalLink, Loader2, LogOut, RefreshCw, Sparkles, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type StepState = "idle" | "loading" | "ok" | "error";

interface AuthStatus {
  veo: { ok: boolean; updatedAt: string | null; projectId: string | null };
  grok: { ok: boolean; profileName: string; updatedAt: string | null };
}

function Badge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300">
      <CheckCircle2 className="h-3 w-3" /> Đã login
    </span>
  ) : (
    <span className="flex items-center gap-1 rounded-full bg-zinc-500/20 px-2 py-0.5 text-xs font-medium text-zinc-400">
      <XCircle className="h-3 w-3" /> Chưa login
    </span>
  );
}

function ActionBtn({
  state,
  onClick,
  children,
  variant = "default",
  disabled,
}: {
  state: StepState;
  onClick: () => void;
  children: React.ReactNode;
  variant?: "default" | "primary" | "ghost";
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    default: "bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700",
    primary:
      "bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:from-fuchsia-600 hover:to-pink-600 text-white shadow-lg shadow-pink-500/20",
    ghost: "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || state === "loading"}
      className={cn(base, variants[variant])}
    >
      {state === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

function ProviderCard({
  title,
  subtitle,
  ok,
  onOpen,
  openState,
  onVerify,
  verifyState,
  onLogout,
  logoutState,
  openMsg,
  verifyMsg,
  instructions,
}: {
  title: string;
  subtitle: string;
  ok: boolean;
  onOpen: () => void;
  openState: StepState;
  onVerify: () => void;
  verifyState: StepState;
  onLogout: () => void;
  logoutState: StepState;
  openMsg?: string;
  verifyMsg?: string;
  instructions: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-5 transition",
        ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800 bg-zinc-900/60"
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
            <Badge ok={ok} />
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
        </div>
        {ok ? (
          <ActionBtn state={logoutState} onClick={onLogout} variant="ghost">
            <LogOut className="h-3.5 w-3.5" /> Logout
          </ActionBtn>
        ) : null}
      </div>

      <div className="mb-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-400">
        {instructions}
      </div>

      <div className="flex flex-wrap gap-2">
        <ActionBtn state={openState} onClick={onOpen} variant="default">
          <ExternalLink className="h-4 w-4" />
          {openState === "loading" ? "Đang mở Chrome..." : "1. Mở Chrome & Login"}
        </ActionBtn>
        <ActionBtn state={verifyState} onClick={onVerify} variant="primary" disabled={ok}>
          <RefreshCw className="h-4 w-4" />
          {verifyState === "loading" ? "Đang xác minh..." : ok ? "Đã xác minh" : "2. Verify & Save"}
        </ActionBtn>
      </div>

      {openMsg ? (
        <p
          className={cn(
            "mt-2 text-xs",
            openState === "error" ? "text-red-400" : "text-zinc-500"
          )}
        >
          {openMsg}
        </p>
      ) : null}
      {verifyMsg ? (
        <p
          className={cn(
            "mt-1 text-xs",
            verifyState === "error" ? "text-red-400" : verifyState === "ok" ? "text-emerald-400" : "text-zinc-500"
          )}
        >
          {verifyMsg}
        </p>
      ) : null}
    </div>
  );
}

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [bypassed, setBypassed] = useState(false);
  const [loading, setLoading] = useState(true);

  const [veoOpen, setVeoOpen] = useState<{ state: StepState; msg?: string }>({ state: "idle" });
  const [veoVerify, setVeoVerify] = useState<{ state: StepState; msg?: string }>({ state: "idle" });
  const [veoLogout, setVeoLogout] = useState<{ state: StepState }>({ state: "idle" });

  const [grokOpen, setGrokOpen] = useState<{ state: StepState; msg?: string }>({ state: "idle" });
  const [grokVerify, setGrokVerify] = useState<{ state: StepState; msg?: string }>({ state: "idle" });
  const [grokLogout, setGrokLogout] = useState<{ state: StepState }>({ state: "idle" });

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/status", { cache: "no-store" });
      const d = (await r.json()) as AuthStatus;
      setStatus(d);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openChrome = useCallback(
    async (target: "veo" | "grok") => {
      const setter = target === "veo" ? setVeoOpen : setGrokOpen;
      setter({ state: "loading" });
      try {
        const r = await fetch("/api/chrome/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        const d = (await r.json()) as { ok: boolean; message?: string };
        setter({ state: d.ok ? "ok" : "error", msg: d.message });
      } catch (e) {
        setter({ state: "error", msg: e instanceof Error ? e.message : String(e) });
      }
    },
    []
  );

  const verify = useCallback(
    async (target: "veo" | "grok") => {
      const setter = target === "veo" ? setVeoVerify : setGrokVerify;
      setter({ state: "loading" });
      try {
        const r = await fetch(`/api/test/${target}`, { method: "POST" });
        const d = (await r.json()) as { ok: boolean; message?: string };
        // Always refresh: the cache may have been saved even if recaptcha/secondary failed
        await refresh();
        setter({ state: d.ok ? "ok" : "error", msg: d.message });
      } catch (e) {
        await refresh();
        setter({ state: "error", msg: e instanceof Error ? e.message : String(e) });
      }
    },
    [refresh]
  );

  const logout = useCallback(
    async (target: "veo" | "grok") => {
      const setter = target === "veo" ? setVeoLogout : setGrokLogout;
      setter({ state: "loading" });
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        if (target === "veo") setVeoVerify({ state: "idle" });
        else setGrokVerify({ state: "idle" });
        await refresh();
      } finally {
        setter({ state: "idle" });
      }
    },
    [refresh]
  );

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-zinc-400">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Đang kiểm tra phiên đăng nhập...
      </div>
    );
  }

  const veoOk = status?.veo.ok ?? false;
  const grokOk = status?.grok.ok ?? false;
  const anyOk = veoOk || grokOk;
  const canEnter = anyOk || bypassed;

  if (canEnter) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950/95 p-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/90 shadow-2xl">
        <div className="border-b border-zinc-800 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-500">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-zinc-100">Đăng nhập để bắt đầu</h2>
              <p className="text-sm text-zinc-400">
                Tool cần phiên đăng nhập VEO 3 Ultra và/hoặc Super Grok Heavy để gọi API. Login 1 lần,
                token được cache tự động.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-6 md:grid-cols-2">
          <ProviderCard
            title="VEO 3 Ultra (Google Flow)"
            subtitle="Cho Text/Image → Video và Create Image (Nano Banana / Imagen)"
            ok={veoOk}
            onOpen={() => openChrome("veo")}
            openState={veoOpen.state}
            openMsg={veoOpen.msg}
            onVerify={() => verify("veo")}
            verifyState={veoVerify.state}
            verifyMsg={
              veoVerify.msg ||
              (veoOk && status?.veo.projectId
                ? `project=${status.veo.projectId.slice(0, 8)}…`
                : undefined)
            }
            onLogout={() => logout("veo")}
            logoutState={veoLogout.state}
            instructions={
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Bấm <b>Mở Chrome & Login</b> → đăng nhập Google có gói VEO 3 Ultra
                </li>
                <li>
                  Vào <span className="text-fuchsia-400">labs.google/fx/tools/flow</span> →{" "}
                  <b>bấm &quot;New Project&quot;</b> hoặc mở 1 project bất kỳ
                </li>
                <li>
                  Quay lại đây bấm <b>Verify & Save</b>
                </li>
              </ol>
            }
          />

          <ProviderCard
            title="Super Grok Heavy (grok.com)"
            subtitle="Cho Grok Imagine: Text/Image → Video + Upscale"
            ok={grokOk}
            onOpen={() => openChrome("grok")}
            openState={grokOpen.state}
            openMsg={grokOpen.msg}
            onVerify={() => verify("grok")}
            verifyState={grokVerify.state}
            verifyMsg={grokVerify.msg}
            onLogout={() => logout("grok")}
            logoutState={grokLogout.state}
            instructions={
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Bấm <b>Mở Chrome & Login</b> → đăng nhập tài khoản Super Grok Heavy
                </li>
                <li>
                  Vào <span className="text-fuchsia-400">grok.com/imagine</span>, thử tạo 1 prompt
                  bất kỳ (để trigger x-statsig-id)
                </li>
                <li>
                  Quay lại đây bấm <b>Verify & Save</b>
                </li>
              </ol>
            }
          />
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 p-4">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <RefreshCw className="h-4 w-4" /> Kiểm tra lại
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setBypassed(true)}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-300"
            >
              Bỏ qua (dùng sau)
            </button>
            <button
              type="button"
              onClick={() => setBypassed(true)}
              disabled={!anyOk}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition",
                anyOk
                  ? "bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white shadow-lg shadow-pink-500/20 hover:from-fuchsia-600 hover:to-pink-600"
                  : "cursor-not-allowed bg-zinc-800 text-zinc-600"
              )}
            >
              Vào app
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
