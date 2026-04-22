"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";

import { cn } from "@/lib/utils";
import { useToastStore } from "@/state/toastStore";

/**
 * Global toast renderer. Mount once at the app root (layout.tsx). Listens to
 * `useToastStore.current` and auto-dismisses after `durationMs`. Positioning
 * is fixed bottom-right so it doesn't collide with the top bar or the
 * QuickAddMenu / SettingsDialog modals (those use `z-[60..]`).
 */
export default function Toaster() {
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (!current || current.durationMs <= 0) return;
    const t = setTimeout(dismiss, current.durationMs);
    return () => clearTimeout(t);
  }, [current, dismiss]);

  if (!current) return null;

  const Icon =
    current.kind === "success"
      ? CheckCircle2
      : current.kind === "error"
        ? AlertTriangle
        : Info;

  const tone =
    current.kind === "success"
      ? "border-emerald-500/40 text-emerald-300"
      : current.kind === "error"
        ? "border-red-500/50 text-red-300"
        : "border-[color:var(--color-border-strong)] text-[color:var(--color-fg)]";

  return (
    <div
      key={current.id}
      role="status"
      aria-live="polite"
      className={cn(
        "fixed bottom-4 right-4 z-[80] max-w-[min(520px,92vw)]",
        "flex items-start gap-2.5 p-3 pr-8",
        "rounded-lg border bg-[color:var(--color-bg-elev-1)] shadow-2xl shadow-black/70",
        tone,
        // Subtle slide-in. Tailwind's default `animate-in` isn't available
        // everywhere in this project, so keep it to a small transform.
        "animate-[toastIn_180ms_ease-out]",
      )}
      style={
        {
          // Inline keyframes so we don't depend on a global CSS file — the
          // toaster component is self-contained and a stylesheet edit is
          // unnecessary for a 1-rule animation.
          "--_tw": undefined,
        } as React.CSSProperties
      }
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold truncate">{current.title}</div>
        {current.detail && (
          <div className="mt-0.5 text-[11px] text-[color:var(--color-fg-muted)] break-all leading-relaxed">
            {current.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="absolute top-2 right-2 h-5 w-5 grid place-items-center rounded text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]"
        title="Dismiss"
      >
        <X className="h-3 w-3" />
      </button>

      <style jsx>{`
        @keyframes toastIn {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
