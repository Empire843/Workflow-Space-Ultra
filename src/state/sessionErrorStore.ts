"use client";

import { create } from "zustand";

import type { SessionProvider } from "@/lib/sessionError";

/**
 * Info for a single session-error awaiting user action.
 * - `provider`: VEO or Grok — determines which login flow is opened.
 * - `message`: raw error text (shown inside the dialog as a code block).
 * - `nodeId` / `nodeLabel`: optional context so the user knows which node failed.
 * - `ts`: push timestamp → in case two session-errors arrive back-to-back, the dialog
 *   only shows the newest one (overwrite).
 */
export interface SessionErrorState {
  provider: SessionProvider;
  message: string;
  nodeId?: string;
  nodeLabel?: string;
  ts: number;
}

interface SessionErrorStore {
  pending: SessionErrorState | null;
  /** Trigger show popup. Idempotent: if the same provider + nodeId is already pending, just refresh message/ts. */
  show: (args: Omit<SessionErrorState, "ts">) => void;
  /** User dismisses the dialog (click Close / Esc / after a successful login). */
  dismiss: () => void;
}

export const useSessionErrorStore = create<SessionErrorStore>((set) => ({
  pending: null,
  show: (args) => set({ pending: { ...args, ts: Date.now() } }),
  dismiss: () => set({ pending: null }),
}));
