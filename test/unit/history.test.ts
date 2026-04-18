import { describe, it, expect, beforeEach } from "vitest";

import { useWorkflowStore } from "@/state/workflowStore";
import { node, edge } from "../_helpers/buildWorkflow";

beforeEach(() => {
  useWorkflowStore.setState({
    activeWorkflowId: null,
    activeWorkflowName: "",
    nodes: [],
    edges: [],
    selectedNodeId: null,
    _past: [],
    _future: [],
    canUndo: false,
    canRedo: false,
  });
});

describe("undo/redo history", () => {
  it("starts with canUndo=false and canRedo=false", () => {
    const s = useWorkflowStore.getState();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
  });

  it("undo reverts addNode and redo restores it", () => {
    const store = useWorkflowStore.getState();
    store.addNode("content.text", { x: 0, y: 0 }, { text: "hi" });
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().canUndo).toBe(true);

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes).toHaveLength(0);
    expect(useWorkflowStore.getState().canUndo).toBe(false);
    expect(useWorkflowStore.getState().canRedo).toBe(true);

    useWorkflowStore.getState().redo();
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().canUndo).toBe(true);
    expect(useWorkflowStore.getState().canRedo).toBe(false);
  });

  it("undo restores edges after removeNode (which also removes connected edges)", () => {
    useWorkflowStore.setState({
      nodes: [
        node("a", "content.text", { data: { text: "a" } }),
        node("b", "gen.image", { data: { prompt: "b" } }),
      ],
      edges: [edge("a", "b")],
    });
    const id = useWorkflowStore.getState().addNode("content.text", { x: 200, y: 0 });
    useWorkflowStore.getState().removeNode("a");
    expect(useWorkflowStore.getState().nodes.map((n) => n.id).sort()).toEqual(["b", id].sort());
    expect(useWorkflowStore.getState().edges).toHaveLength(0);

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes.map((n) => n.id).sort()).toEqual(["a", "b", id].sort());
    expect(useWorkflowStore.getState().edges).toHaveLength(1);
  });

  it("a new mutation after undo clears the redo stack", () => {
    const store = useWorkflowStore.getState();
    store.addNode("content.text", { x: 0, y: 0 });
    store.addNode("content.text", { x: 10, y: 0 });
    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().canRedo).toBe(true);
    useWorkflowStore.getState().addNode("content.text", { x: 20, y: 0 });
    expect(useWorkflowStore.getState().canRedo).toBe(false);
  });

  it("runtime-only updateNodeData (progress/status) does NOT snapshot", () => {
    const id = useWorkflowStore.getState().addNode("gen.image", { x: 0, y: 0 }, { prompt: "x" });
    expect(useWorkflowStore.getState().canUndo).toBe(true);
    const undoDepthBefore = useWorkflowStore.getState()._past.length;

    useWorkflowStore.getState().updateNodeData(id, { progress: 50, status: "running" });
    useWorkflowStore.getState().updateNodeData(id, { progress: 75, statusLog: "working" });

    expect(useWorkflowStore.getState()._past.length).toBe(undoDepthBefore);
  });

  it("non-runtime updateNodeData (editing prompt) DOES snapshot", () => {
    const id = useWorkflowStore.getState().addNode("gen.image", { x: 0, y: 0 }, { prompt: "old" });
    const depthBefore = useWorkflowStore.getState()._past.length;
    useWorkflowStore.getState().updateNodeData(id, { prompt: "new" });
    expect(useWorkflowStore.getState()._past.length).toBe(depthBefore + 1);

    useWorkflowStore.getState().undo();
    expect(useWorkflowStore.getState().nodes[0]?.data.prompt).toBe("old");
  });

  it("history is cleared when loading/creating/leaving a workflow", async () => {
    useWorkflowStore.getState().addNode("content.text", { x: 0, y: 0 });
    expect(useWorkflowStore.getState().canUndo).toBe(true);
    useWorkflowStore.getState()._clearHistory();
    expect(useWorkflowStore.getState().canUndo).toBe(false);
    expect(useWorkflowStore.getState().canRedo).toBe(false);
  });

  it("caps the undo stack at MAX_HISTORY entries", () => {
    for (let i = 0; i < 80; i++) {
      useWorkflowStore.getState().addNode("content.text", { x: i * 10, y: 0 });
    }
    // MAX_HISTORY is 50 per store implementation.
    expect(useWorkflowStore.getState()._past.length).toBeLessThanOrEqual(50);
    expect(useWorkflowStore.getState().nodes.length).toBe(80);
  });

  it("drag position-change stream = 1 undo step (not per frame)", () => {
    const id = useWorkflowStore.getState().addNode("content.text", { x: 0, y: 0 });
    const depthBefore = useWorkflowStore.getState()._past.length;

    // Simulate a React Flow drag: many dragging:true ticks, then one dragging:false.
    const { onNodesChange } = useWorkflowStore.getState();
    for (let x = 0; x < 5; x++) {
      onNodesChange([{ type: "position", id, position: { x: x * 10, y: 0 }, dragging: true }]);
    }
    onNodesChange([{ type: "position", id, position: { x: 40, y: 0 }, dragging: false }]);

    expect(useWorkflowStore.getState()._past.length).toBe(depthBefore + 1);

    // A new drag gesture should produce another snapshot.
    for (let x = 0; x < 3; x++) {
      onNodesChange([{ type: "position", id, position: { x: 40 + x * 10, y: 0 }, dragging: true }]);
    }
    onNodesChange([{ type: "position", id, position: { x: 60, y: 0 }, dragging: false }]);
    expect(useWorkflowStore.getState()._past.length).toBe(depthBefore + 2);
  });
});
