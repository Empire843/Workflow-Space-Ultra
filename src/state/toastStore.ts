"use client";

import { create } from "zustand";

/**
 * Minimal toast store. Sufficient for short "export OK / failed" blips without
 * pulling in a dependency. One toast at a time — showing a new one replaces
 * the current one (the only alternative is a queue, which we don't need for
 * the handful of places that call this).
 *
 * The Toaster component listens and renders. Imperative callers should use
 * `toast.success(...)`, `toast.error(...)`, or `toast.info(...)` exports
 * below — they're easier to read at call sites than `useToastStore.getState().show(...)`.
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastState {
  id: number;
  kind: ToastKind;
  title: string;
  /** Optional secondary line (path, count, etc.). */
  detail?: string;
  /** ms before auto-dismiss. 0 = sticky. */
  durationMs: number;
}

interface ToastStore {
  current: ToastState | null;
  show: (t: Omit<ToastState, "id">) => void;
  dismiss: () => void;
}

let _nextId = 1;

export const useToastStore = create<ToastStore>((set) => ({
  current: null,
  show: (t) => set({ current: { id: _nextId++, ...t } }),
  dismiss: () => set({ current: null }),
}));

export const toast = {
  success: (title: string, detail?: string, durationMs = 3500) =>
    useToastStore
      .getState()
      .show({ kind: "success", title, detail, durationMs }),
  error: (title: string, detail?: string, durationMs = 6000) =>
    useToastStore.getState().show({ kind: "error", title, detail, durationMs }),
  info: (title: string, detail?: string, durationMs = 3500) =>
    useToastStore.getState().show({ kind: "info", title, detail, durationMs }),
};
