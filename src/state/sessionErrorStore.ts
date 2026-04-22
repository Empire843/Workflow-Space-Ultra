"use client";

import { create } from "zustand";

import type { SessionErrorKind, SessionProvider } from "@/lib/sessionError";

/**
 * Info for a single session-error awaiting user action.
 * - `provider`: VEO or Grok — determines which login flow is opened.
 * - `kind`: differentiates "really expired, please re-login" from
 *   "Chrome is fine, the page just hiccupped". Defaults to
 *   `"auth-expired"` when omitted to preserve the legacy popup behaviour.
 * - `message`: raw error text (shown inside the dialog as a code block).
 * - `nodeId` / `nodeLabel`: optional context so the user knows which node failed.
 * - `ts`: push timestamp → in case two session-errors arrive back-to-back, the dialog
 *   only shows the newest one (overwrite).
 */
export interface SessionErrorState {
  provider: SessionProvider;
  kind: SessionErrorKind;
  message: string;
  nodeId?: string;
  nodeLabel?: string;
  ts: number;
}

interface SessionErrorStore {
  pending: SessionErrorState | null;
  /** Trigger show popup. Idempotent: if the same provider + nodeId is already pending, just refresh message/ts. */
  show: (args: Omit<SessionErrorState, "ts" | "kind"> & { kind?: SessionErrorKind }) => void;
  /** User dismisses the dialog (click Close / Esc / after a successful login). */
  dismiss: () => void;
}

export const useSessionErrorStore = create<SessionErrorStore>((set) => ({
  pending: null,
  show: (args) =>
    set({
      pending: {
        kind: "auth-expired",
        ...args,
        ts: Date.now(),
      },
    }),
  dismiss: () => set({ pending: null }),
}));
