"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useWorkflowStore } from "@/state/workflowStore";
import type { NodeKind } from "@/lib/nodes";

import FrameNode from "./FrameNode";
import QuickAddMenu from "./QuickAddMenu";
import ScenesImportDialog from "./ScenesImportDialog";
import AnalyzeVideoDialog from "./AnalyzeVideoDialog";
import WSNode from "./WSNode";

const nodeTypes: NodeTypes = { wsNode: WSNode, frame: FrameNode };

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <Inner />
    </ReactFlowProvider>
  );
}

function Inner() {
  // Split selectors with shallow equality to avoid full re-render on every
  // node/edge patch (e.g. progress ticks). `nodes`/`edges` identity changes
  // intentionally; other slices stay stable.
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  const canvasTool = useWorkflowStore((s) => s.canvasTool);
  const showMinimap = useWorkflowStore((s) => s.showMinimap);
  const { onNodesChange, onEdgesChange, onConnect, addNode, selectNode, setCanvasTool, toggleMinimap } =
    useWorkflowStore(
      useShallow((s) => ({
        onNodesChange: s.onNodesChange,
        onEdgesChange: s.onEdgesChange,
        onConnect: s.onConnect,
        addNode: s.addNode,
        selectNode: s.selectNode,
        setCanvasTool: s.setCanvasTool,
        toggleMinimap: s.toggleMinimap,
      })),
    );

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Tracks whether the user is currently (or just was) dragging a node.
  // `onNodeClick` can still fire after a drag in some edge cases (e.g.
  // sub-threshold jitter or when d3-drag decides the gesture is a click).
  // Without this flag the bottom inspector would pop open mid-gesture and
  // intercept the pointerup, leaving the node stuck to the cursor.
  const draggingRef = useRef(false);
  const dragGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Quick-add menu: right-click the empty pane to open a searchable node picker
  // at the cursor. `flow*` = world coords where the spawned node will land;
  // `screen*` = viewport pixels for positioning the menu.
  const [quickAdd, setQuickAdd] = useState<
    { screenX: number; screenY: number; flowX: number; flowY: number } | null
  >(null);
  // Scenes Import dialog — opened from QuickAddMenu's "Import scenes" action.
  // Carries the flow-coord anchor so the batch lands where the user clicked.
  const [scenesImport, setScenesImport] = useState<{ flowX: number; flowY: number } | null>(null);
  // Initial state for ScenesImportDialog when opened via Clone Video.
  const [scenesInitial, setScenesInitial] = useState<{
    imagePrompts: string; videoPrompts: string; aspectRatio: "16:9" | "9:16" | "1:1";
    sharedStyle?: string;
  } | null>(null);
  // Analyze Video (Clone) dialog state.
  const [analyzeVideo, setAnalyzeVideo] = useState(false);

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setQuickAdd({ screenX: e.clientX, screenY: e.clientY, flowX: flow.x, flowY: flow.y });
    },
    [screenToFlowPosition],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData("application/wsu-node-kind") as NodeKind;
      if (!kind) return;
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(kind, pos);
    },
    [addNode, screenToFlowPosition]
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const defaultEdgeOptions = useMemo(
    () => ({ animated: true, style: { stroke: "#4b4b55", strokeWidth: 1.5 } }),
    []
  );

  // Global keyboard shortcuts — only fire when no input/textarea is focused
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const isEditable = tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable;

      // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z = redo, Ctrl+Y = redo (Windows style)
      // Intercepted even inside inputs is tempting but confuses users — they
      // expect native text-field undo there. So gate by !isEditable.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !isEditable) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          useWorkflowStore.getState().undo();
          return;
        }
        if ((key === "z" && e.shiftKey) || key === "y") {
          e.preventDefault();
          useWorkflowStore.getState().redo();
          return;
        }
      }

      if (isEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "v":
          setCanvasTool("select");
          break;
        case "h":
          setCanvasTool("pan");
          break;
        case "t": {
          const pos = screenToFlowPosition({
            x: window.innerWidth / 2 + Math.random() * 100 - 50,
            y: window.innerHeight / 2 + Math.random() * 100 - 50,
          });
          addNode("content.text", pos);
          break;
        }
        case "i": {
          const pos = screenToFlowPosition({
            x: window.innerWidth / 2 + Math.random() * 100 - 50,
            y: window.innerHeight / 2 + Math.random() * 100 - 50,
          });
          addNode("content.upload", pos);
          break;
        }
        case "g": {
          const pos = screenToFlowPosition({
            x: window.innerWidth / 2 + Math.random() * 100 - 50,
            y: window.innerHeight / 2 + Math.random() * 100 - 50,
          });
          addNode("gen.video", pos);
          break;
        }
        case "f": {
          // Drop the Frame centred on the viewport so it's immediately visible
          // and wraps whatever the user is currently looking at.
          const centre = screenToFlowPosition({
            x: window.innerWidth / 2 - 300,
            y: window.innerHeight / 2 - 200,
          });
          addNode("frame", centre);
          break;
        }
        case "l":
          toggleMinimap();
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addNode, setCanvasTool, toggleMinimap, screenToFlowPosition]);

  // Clear any pending drag-guard timer on unmount to avoid a stale ref write
  // into a detached component.
  useEffect(() => {
    return () => {
      if (dragGuardTimerRef.current) {
        clearTimeout(dragGuardTimerRef.current);
        dragGuardTimerRef.current = null;
      }
    };
  }, []);

  // Last-resort safety net for the "node stuck to cursor" bug.
  //
  // React Flow uses d3-drag which tracks an internal `dragStarted` flag and
  // emits `position` changes with `dragging: true` until it receives a
  // `mouseup`. If that teardown ever fails to complete (e.g. a React re-render
  // triggered mid-gesture causes pointer-events to be re-routed elsewhere),
  // nodes keep following the cursor even after the user has released the
  // mouse. We cannot force d3-drag's internal state from the outside, but we
  // can make React Flow stop tracking the node as dragged by emitting a final
  // `dragging: false` position change ourselves. That resets the store
  // snapshot machinery (via `onNodesChange`) and, more importantly, breaks
  // the render loop that would otherwise render the node at every mousemove.
  useEffect(() => {
    function forceEndDrag() {
      const store = useWorkflowStore.getState();
      const stuck = store.nodes.filter(
        (n) => (n as unknown as { dragging?: boolean }).dragging,
      );
      if (!stuck.length) return;
      store.onNodesChange(
        stuck.map((n) => ({
          type: "position" as const,
          id: n.id,
          position: n.position,
          dragging: false,
        })),
      );
    }
    // Capture phase so we run before React's synthetic handlers; `mouseup`
    // (not `pointerup`) because d3-drag's own listener is on `mouseup` and
    // we want to piggy-back on the same lifecycle.
    window.addEventListener("mouseup", forceEndDrag, true);
    window.addEventListener("pointerup", forceEndDrag, true);
    window.addEventListener("pointercancel", forceEndDrag, true);
    window.addEventListener("blur", forceEndDrag);
    return () => {
      window.removeEventListener("mouseup", forceEndDrag, true);
      window.removeEventListener("pointerup", forceEndDrag, true);
      window.removeEventListener("pointercancel", forceEndDrag, true);
      window.removeEventListener("blur", forceEndDrag);
    };
  }, []);

  const isPan = canvasTool === "pan";

  return (
    <div
      ref={wrapperRef}
      className={`absolute inset-0 pt-12 ${isPan ? "cursor-grab active:cursor-grabbing" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        onPaneClick={() => {
          selectNode(null);
          setQuickAdd(null);
        }}
        onPaneContextMenu={onPaneContextMenu}
        onMoveStart={() => setQuickAdd(null)}
        onNodeContextMenu={() => setQuickAdd(null)}
        // Drag lifecycle — used purely to gate `onNodeClick` below so the
        // bottom inspector does not pop open at the end of a drag gesture.
        onNodeDragStart={() => {
          draggingRef.current = true;
          if (dragGuardTimerRef.current) clearTimeout(dragGuardTimerRef.current);
        }}
        onNodeDragStop={() => {
          // Keep the flag up for one microtask: any trailing `onNodeClick`
          // that d3-drag still decides to fire must be ignored, otherwise
          // the layout shift from mounting the inspector could swallow the
          // pointerup event and leave the node stuck following the cursor.
          if (dragGuardTimerRef.current) clearTimeout(dragGuardTimerRef.current);
          dragGuardTimerRef.current = setTimeout(() => {
            draggingRef.current = false;
            dragGuardTimerRef.current = null;
          }, 50);
        }}
        // Also require a non-trivial movement before a press is treated as
        // a drag. At the default 0px threshold any jitter while clicking
        // triggers a full drag gesture that the runtime then has to end —
        // and that race is exactly where the "stuck node" bug was born.
        nodeDragThreshold={3}
        onNodeClick={(_, node) => {
          if (draggingRef.current) return;
          selectNode(node.id);
        }}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={{ hideAttribution: true }}
        fitView
        minZoom={0.2}
        maxZoom={2}
        // Perf: only mount nodes/edges intersecting the viewport. Dramatic
        // savings once the canvas has dozens of media previews.
        onlyRenderVisibleElements
        /* Delete selected nodes/edges with both Delete and Backspace.
         * React Flow emits `{type: "remove"}` changes → applied by `onNodesChange` /
         * `onEdgesChange` in the store. Edges attached to a removed node are
         * also auto-removed by React Flow v12. Every node/edge has
         * `deletable: true` by default, so no extra override is needed. */
        deleteKeyCode={["Delete", "Backspace"]}
        // Interaction mode props
        panOnDrag={isPan ? true : [1, 2]}
        selectionOnDrag={!isPan}
        nodesDraggable={!isPan}
        panOnScroll={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="#3a3a44" />
        {showMinimap && (
          <MiniMap
            pannable
            zoomable
            className="!bg-[color:var(--color-bg-elev-2)]"
            nodeColor={(n) => {
              const d = n.data as { status?: string };
              if (d.status === "running") return "#ff3c8e";
              if (d.status === "done") return "#3ecf8e";
              if (d.status === "error") return "#ef4444";
              return "#3a3a42";
            }}
          />
        )}
        <Controls position="bottom-left" />
      </ReactFlow>
      {quickAdd && (
        <QuickAddMenu
          screenX={quickAdd.screenX}
          screenY={quickAdd.screenY}
          flowX={quickAdd.flowX}
          flowY={quickAdd.flowY}
          onClose={() => setQuickAdd(null)}
          onOpenScenesImport={(flowX, flowY) => {
            setScenesInitial(null);
            setScenesImport({ flowX, flowY });
          }}
          onOpenAnalyzeVideo={() => setAnalyzeVideo(true)}
        />
      )}
      {scenesImport && (
        <ScenesImportDialog
          flowX={scenesImport.flowX}
          flowY={scenesImport.flowY}
          onClose={() => {
            setScenesImport(null);
            setScenesInitial(null);
          }}
          initialState={scenesInitial ?? undefined}
        />
      )}
      {analyzeVideo && (
        <AnalyzeVideoDialog
          onClose={() => setAnalyzeVideo(false)}
          onResult={(result) => {
            setAnalyzeVideo(false);
            setScenesInitial(result);
            // Open ScenesImportDialog centred on viewport
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const flow = screenToFlowPosition({ x: cx, y: cy });
            setScenesImport({ flowX: flow.x, flowY: flow.y });
          }}
        />
      )}
    </div>
  );
}
