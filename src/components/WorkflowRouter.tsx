"use client";

import { useWorkflowStore } from "@/state/workflowStore";

import CanvasShell from "./canvas/CanvasShell";
import WorkflowDashboard from "./dashboard/WorkflowDashboard";
import NodeInspector from "./inspector/NodeInspector";
import SessionErrorDialog from "./session/SessionErrorDialog";
import LeftToolbar from "./toolbar/LeftToolbar";
import NodePalette from "./sidebar/NodePalette";
import TopBar from "./topbar/TopBar";

export default function WorkflowRouter() {
  const activeId = useWorkflowStore((s) => s.activeWorkflowId);
  const showPalette = useWorkflowStore((s) => s.showPalette);

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
      {showPalette && <NodePalette />}
      <NodeInspector />
      <SessionErrorDialog />
    </main>
  );
}
