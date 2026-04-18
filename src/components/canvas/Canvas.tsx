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
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useWorkflowStore } from "@/state/workflowStore";
import type { NodeKind } from "@/lib/nodes";

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
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    selectNode,
    canvasTool,
    showMinimap,
    showPalette,
    setCanvasTool,
    togglePalette,
    toggleMinimap,
  } = useWorkflowStore();

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

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
      if (tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable) return;
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
        onPaneClick={() => selectNode(null)}
        defaultEdgeOptions={defaultEdgeOptions}
        proOptions={{ hideAttribution: true }}
        fitView
        minZoom={0.2}
        maxZoom={2}
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
    </div>
  );
}
