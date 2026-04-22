"use client";

import { useEffect, useRef } from "react";

import { useWorkflowStore } from "@/state/workflowStore";

import CanvasShell from "./canvas/CanvasShell";
import WorkflowDashboard from "./dashboard/WorkflowDashboard";
import NodeInspector from "./inspector/NodeInspector";
import SessionErrorDialog from "./session/SessionErrorDialog";
import LeftToolbar from "./toolbar/LeftToolbar";
import TopBar from "./topbar/TopBar";

export default function WorkflowRouter() {
  const activeId = useWorkflowStore((s) => s.activeWorkflowId);
  const lastPrewarmId = useRef<string | null>(null);

  // Fire a best-effort pre-warm as soon as a workflow opens. Server-side
  // dedupe means this is safe to call even if the user rapidly toggles
  // between workflows — only the first POST kicks off real work. The
  // collector is primed before the user clicks Run, so the first job no
  // longer eats the 20-30s cold start.
  useEffect(() => {
    if (!activeId) return;
    if (lastPrewarmId.current === activeId) return;
    lastPrewarmId.current = activeId;
    fetch("/api/auth/prewarm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targets: ["veo", "grok"] }),
    }).catch(() => {
      // ignore — prewarm is best-effort, the 401 retry loop is the real
      // safety net for expired tokens.
    });
  }, [activeId]);

  if (!activeId) {
    return (
      <>
        <WorkflowDashboard />
        <SessionErrorDialog />
      </>
    );
  }

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[color:var(--color-bg)] text-[color:var(--color-fg)]">
      <TopBar />
      <LeftToolbar />
      <CanvasShell />
      <NodeInspector />
      <SessionErrorDialog />
    </main>
  );
}
