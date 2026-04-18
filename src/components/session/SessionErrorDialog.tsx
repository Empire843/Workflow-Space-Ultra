"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { SessionProvider } from "@/lib/sessionError";
import { useSessionErrorStore } from "@/state/sessionErrorStore";

type Step = "idle" | "opening" | "waiting" | "verified" | "failed";

interface AuthStatus {
  veo?: { ok: boolean };
  grok?: { ok: boolean };
}

async function fetchAuthOk(provider: SessionProvider): Promise<boolean> {
  try {
    const r = await fetch("/api/auth/status", { cache: "no-store" });
    const d = (await r.json()) as AuthStatus;
    return Boolean(d?.[provider]?.ok);
  } catch {
    return false;
  }
}

/**
 * Global modal shown when a node fails with a session/auth error.
 *
 * Flow:
 *  1. Store sets `pending` → dialog renders with the message + provider.
 *  2. User clicks "Mở Chrome & Login" → POST /api/chrome/open { target: provider }.
 *  3. Dialog switches to "waiting" state + polls /api/auth/status every 3s.
 *  4. When `auth[provider].ok === true` → reports success → user clicks "Đóng" or
 *     it auto-dismisses after 1.5s.
 *  5. User can click "Verify Now" to force POST /api/test/<provider>.
 */
export default function SessionErrorDialog() {
  const pending = useSessionErrorStore((s) => s.pending);
  const dismiss = useSessionErrorStore((s) => s.dismiss);
  const [step, setStep] = useState<Step>("idle");
  const [statusMsg, setStatusMsg] = useState<string>("");
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Reset when pending changes (dialog is hidden or a new error arrives)
  useEffect(() => {
    setStep("idle");
    setStatusMsg("");
    return () => stopPolling();
  }, [pending?.ts, stopPolling]);

  // Escape → close
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopPolling();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, dismiss, stopPolling]);

  if (!pending) return null;

  const { provider, message, nodeLabel } = pending;
  const providerName = provider === "veo" ? "VEO 3" : "Super Grok";

  const openChrome = async () => {
    setStep("opening");
    setStatusMsg("Đang mở Chrome…");
    try {
      const r = await fetch("/api/chrome/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: provider }),
      });
      const d = (await r.json()) as { ok: boolean; message?: string };
      if (!d.ok) {
        setStep("failed");
        setStatusMsg(d.message || "Mở Chrome thất bại");
        return;
      }
      setStep("waiting");
      setStatusMsg(
        provider === "veo"
          ? "Đã mở Chrome VEO. Đăng nhập Google → mở/tạo 1 project trong Flow → chờ tự động xác minh…"
          : "Đã mở Chrome Grok. Đăng nhập → thử tạo 1 prompt bất kỳ ở grok.com/imagine → chờ tự động xác minh…",
      );
      // Auto-kick verify + poll
      void verify({ silent: true });
      startPolling();
    } catch (err) {
      setStep("failed");
      setStatusMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const startPolling = () => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      const ok = await fetchAuthOk(provider);
      if (ok) {
        stopPolling();
        setStep("verified");
        setStatusMsg(`${providerName} đã sẵn sàng. Bạn có thể đóng dialog và chạy lại node.`);
      }
    }, 3000);
  };

  const verify = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) {
      setStep("waiting");
      setStatusMsg("Đang gọi /api/test để xác minh…");
    }
    try {
      await fetch(`/api/test/${provider}`, { method: "POST" });
    } catch {
      /* ignore — rely on polling */
    }
    const ok = await fetchAuthOk(provider);
    if (ok) {
      stopPolling();
      setStep("verified");
      setStatusMsg(`${providerName} đã sẵn sàng. Bạn có thể đóng dialog và chạy lại node.`);
    } else if (!silent) {
      setStatusMsg(
        provider === "veo"
          ? "Chưa thấy VEO sẵn sàng. Đảm bảo đã mở 1 project trên labs.google/fx/tools/flow rồi thử Verify lại."
          : "Chưa thấy Grok sẵn sàng. Đảm bảo đã login grok.com và thử tạo 1 prompt Imagine rồi Verify lại.",
      );
    }
  };

  const close = () => {
    stopPolling();
    dismiss();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900/95 shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-800 p-4">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg",
                provider === "veo"
                  ? "bg-blue-500/15 text-blue-300"
                  : "bg-fuchsia-500/15 text-fuchsia-300",
              )}
            >
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-100">
                Cần đăng nhập lại {providerName}
              </h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                {nodeLabel
                  ? `Node "${nodeLabel}" không chạy được vì session ${providerName} đã hết hạn hoặc chưa sẵn sàng.`
                  : `Một node không chạy được vì session ${providerName} đã hết hạn hoặc chưa sẵn sàng.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Đóng"
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div className="max-h-32 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/80 p-2 font-mono text-[11px] leading-relaxed text-red-300">
            {message}
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-3 text-xs leading-relaxed text-zinc-400">
            {provider === "veo" ? (
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Bấm <b>Mở Chrome &amp; Login VEO</b> bên dưới
                </li>
                <li>
                  Đăng nhập Google có gói VEO 3 Ultra
                </li>
                <li>
                  Vào <span className="text-fuchsia-300">labs.google/fx/tools/flow</span> → bấm{" "}
                  <b>&quot;New Project&quot;</b> hoặc mở 1 project bất kỳ
                </li>
                <li>Dialog này sẽ tự xác minh khi session sẵn sàng.</li>
              </ol>
            ) : (
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Bấm <b>Mở Chrome &amp; Login Grok</b> bên dưới
                </li>
                <li>Đăng nhập tài khoản Super Grok Heavy</li>
                <li>
                  Vào <span className="text-fuchsia-300">grok.com/imagine</span>, thử tạo 1 prompt
                  bất kỳ (để trigger <code>x-statsig-id</code>)
                </li>
                <li>Dialog này sẽ tự xác minh khi session sẵn sàng.</li>
              </ol>
            )}
          </div>

          {statusMsg ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-md border p-2 text-xs",
                step === "verified"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : step === "failed"
                  ? "border-red-500/40 bg-red-500/10 text-red-300"
                  : "border-zinc-700 bg-zinc-800/40 text-zinc-300",
              )}
            >
              {step === "waiting" || step === "opening" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
              ) : step === "verified" ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              ) : step === "failed" ? (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              ) : null}
              <span>{statusMsg}</span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 p-3">
          <button
            type="button"
            onClick={close}
            className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            Đóng
          </button>
          <button
            type="button"
            onClick={() => void verify()}
            disabled={step === "opening"}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Verify Now
          </button>
          <button
            type="button"
            onClick={() => void openChrome()}
            disabled={step === "opening" || step === "verified"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60",
              provider === "veo"
                ? "bg-gradient-to-r from-blue-500 to-sky-500 hover:opacity-95"
                : "bg-gradient-to-r from-fuchsia-500 to-pink-500 hover:opacity-95",
            )}
          >
            {step === "opening" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            Mở Chrome &amp; Login {providerName}
          </button>
        </div>
      </div>
    </div>
  );
}
