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

import QuickAddMenu from "./QuickAddMenu";
import WSNode from "./WSNode";

const nodeTypes: NodeTypes = { wsNode: WSNode };

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
  const showPalette = useWorkflowStore((s) => s.showPalette);
  const { onNodesChange, onEdgesChange, onConnect, addNode, selectNode, setCanvasTool, togglePalette, toggleMinimap } =
    useWorkflowStore(
      useShallow((s) => ({
        onNodesChange: s.onNodesChange,
        onEdgesChange: s.onEdgesChange,
        onConnect: s.onConnect,
        addNode: s.addNode,
        selectNode: s.selectNode,
        setCanvasTool: s.setCanvasTool,
        togglePalette: s.togglePalette,
        toggleMinimap: s.toggleMinimap,
      })),
    );

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Quick-add menu: right-click the empty pane to open a searchable node picker
  // at the cursor. `flow*` = world coords where the spawned node will land;
  // `screen*` = viewport pixels for positioning the menu.
  const [quickAdd, setQuickAdd] = useState<
    { screenX: number; screenY: number; flowX: number; flowY: number } | null
  >(null);

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
        case "p":
          togglePalette();
          break;
        case "l":
          toggleMinimap();
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addNode, setCanvasTool, togglePalette, toggleMinimap, screenToFlowPosition]);

  const isPan = canvasTool === "pan";

  return (
    <div
      ref={wrapperRef}
      className={`absolute inset-0 pt-12 transition-all duration-200 ${showPalette ? "pr-80" : "pr-0"} ${isPan ? "cursor-grab active:cursor-grabbing" : ""}`}
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
        panOnScroll={false}
        zoomOnScroll={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#26262a" />
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
        />
      )}
    </div>
  );
}
