"use client";

import {
  ArrowLeftRight,
  FileImage,
  FileVideo,
  Hand,
  Image as ImageIcon,
  ImagePlay,
  Layers,
  MousePointer2,
  Shapes,
  Sparkles,
  Type,
  Video as VideoIcon,
  Wand2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { GenMode, NodeDataBase, NodeKind } from "@/lib/nodes";
import { useWorkflowStore } from "@/state/workflowStore";
import type { CanvasTool } from "@/state/workflowStore";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface FlyoutItem {
  icon: React.ElementType;
  label: string;
  sublabel?: string;
  nodeKind: NodeKind;
  /** Extra fields merged into node.data when the node is spawned. */
  extra?: Partial<NodeDataBase>;
}

type ToolItem =
  | {
      type: "tool";
      icon: React.ElementType;
      label: string;
      shortcut?: string;
      toolMode: CanvasTool;
    }
  | {
      type: "add";
      icon: React.ElementType;
      label: string;
      shortcut?: string;
      nodeKind: NodeKind;
    }
  | {
      type: "toggle";
      icon: React.ElementType;
      label: string;
      shortcut?: string;
      toggleKey: "showPalette" | "showMinimap";
    }
  | {
      type: "flyout";
      icon: React.ElementType;
      label: string;
      shortcut?: string;
      flyout: FlyoutItem[];
    };

/* -------------------------------------------------------------------------- */
/*                                 Flyout data                                */
/* -------------------------------------------------------------------------- */

const IMAGE_FLYOUT: FlyoutItem[] = [
  {
    icon: FileImage,
    label: "Upload Image",
    sublabel: "Từ máy",
    nodeKind: "content.upload",
    extra: { uploadAccept: "image/*" },
  },
  {
    icon: Wand2,
    label: "Generate · VEO",
    sublabel: "Text → Image",
    nodeKind: "gen.image",
    extra: { genMode: "t2i.veo" satisfies GenMode },
  },
];

const VIDEO_FLYOUT: FlyoutItem[] = [
  {
    icon: FileVideo,
    label: "Upload Video",
    sublabel: "Từ máy",
    nodeKind: "content.upload",
    extra: { uploadAccept: "video/*" },
  },
  {
    icon: Wand2,
    label: "Text → Video · VEO",
    nodeKind: "gen.video",
    extra: { genMode: "t2v.veo" satisfies GenMode },
  },
  {
    icon: Sparkles,
    label: "Text → Video · Grok",
    nodeKind: "gen.video",
    extra: { genMode: "t2v.grok" satisfies GenMode },
  },
  {
    icon: ImagePlay,
    label: "Image → Video · VEO",
    nodeKind: "gen.video",
    extra: { genMode: "i2v.veo" satisfies GenMode },
  },
  {
    icon: ImagePlay,
    label: "Image → Video · Grok",
    nodeKind: "gen.video",
    extra: { genMode: "i2v.grok" satisfies GenMode },
  },
  {
    icon: ArrowLeftRight,
    label: "Start + End → Video · VEO",
    nodeKind: "gen.start-end",
  },
];

const TOOL_ITEMS: ToolItem[] = [
  { type: "tool", icon: MousePointer2, label: "Select", shortcut: "V", toolMode: "select" },
  { type: "tool", icon: Hand, label: "Pan", shortcut: "H", toolMode: "pan" },
  { type: "toggle", icon: Shapes, label: "Node Palette", shortcut: "P", toggleKey: "showPalette" },
  { type: "add", icon: Type, label: "Add Text Node", shortcut: "T", nodeKind: "content.text" },
  { type: "flyout", icon: ImageIcon, label: "Image", shortcut: "I", flyout: IMAGE_FLYOUT },
  { type: "flyout", icon: VideoIcon, label: "Video", shortcut: "G", flyout: VIDEO_FLYOUT },
  { type: "toggle", icon: Layers, label: "Toggle Minimap", shortcut: "L", toggleKey: "showMinimap" },
];

/* -------------------------------------------------------------------------- */
/*                                  Component                                 */
/* -------------------------------------------------------------------------- */

export default function LeftToolbar() {
  const canvasTool = useWorkflowStore((s) => s.canvasTool);
  const showPalette = useWorkflowStore((s) => s.showPalette);
  const showMinimap = useWorkflowStore((s) => s.showMinimap);
  const setCanvasTool = useWorkflowStore((s) => s.setCanvasTool);
  const togglePalette = useWorkflowStore((s) => s.togglePalette);
  const toggleMinimap = useWorkflowStore((s) => s.toggleMinimap);
  const addNode = useWorkflowStore((s) => s.addNode);

  function spawnNode(kind: NodeKind, extra?: Partial<NodeDataBase>) {
    addNode(
      kind,
      {
        x: 250 + Math.random() * 300,
        y: 150 + Math.random() * 200,
      },
      extra,
    );
  }

  function handleClick(item: ToolItem) {
    if (item.type === "tool") {
      setCanvasTool(item.toolMode);
    } else if (item.type === "add") {
      spawnNode(item.nodeKind);
    } else if (item.type === "toggle") {
      if (item.toggleKey === "showPalette") togglePalette();
      else toggleMinimap();
    }
    /* flyout: handled by FlyoutButton hover menu, do nothing when the main icon is clicked */
  }

  function isActive(item: ToolItem): boolean {
    if (item.type === "tool") return canvasTool === item.toolMode;
    if (item.type === "toggle") {
      if (item.toggleKey === "showPalette") return showPalette;
      if (item.toggleKey === "showMinimap") return showMinimap;
    }
    return false;
  }

  return (
    <div className="absolute top-16 left-3 z-20 flex flex-col gap-1 p-1.5 rounded-xl bg-[color:var(--color-bg-elev-1)] border border-[color:var(--color-border)] shadow-xl">
      {TOOL_ITEMS.map((item) => {
        if (item.type === "flyout") {
          return (
            <FlyoutButton
              key={item.label}
              item={item}
              onPick={(fi) => spawnNode(fi.nodeKind, fi.extra)}
            />
          );
        }
        const Icon = item.icon;
        const active = isActive(item);
        return (
          <button
            key={item.label}
            type="button"
            title={item.shortcut ? `${item.label} [${item.shortcut}]` : item.label}
            onClick={() => handleClick(item)}
            className={cn(
              "h-9 w-9 grid place-items-center rounded-lg transition",
              active
                ? "bg-[color:var(--color-accent)] text-white"
                : "text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*                                FlyoutButton                                */
/* -------------------------------------------------------------------------- */

function FlyoutButton({
  item,
  onPick,
}: {
  item: Extract<ToolItem, { type: "flyout" }>;
  onPick: (fi: FlyoutItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleOpen = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => {
      setOpen(true);
      openTimer.current = null;
    }, 120);
  };

  const scheduleClose = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 200);
  };

  useEffect(() => () => clearTimers(), []);

  const Icon = item.icon;

  return (
    <div
      className="relative"
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        title={item.shortcut ? `${item.label} [${item.shortcut}]` : item.label}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "h-9 w-9 grid place-items-center rounded-lg transition",
          open
            ? "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)]"
            : "text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]",
        )}
      >
        <Icon className="h-4 w-4" />
      </button>

      {open && (
        <FlyoutPanel
          items={item.flyout}
          onPick={(fi) => {
            onPick(fi);
            setOpen(false);
            clearTimers();
          }}
        />
      )}
    </div>
  );
}

function FlyoutPanel({
  items,
  onPick,
}: {
  items: FlyoutItem[];
  onPick: (fi: FlyoutItem) => void;
}) {
  return (
    <div
      className={cn(
        "absolute left-full top-0 ml-2 flex items-center gap-1",
        "rounded-xl bg-[color:var(--color-bg-elev-1)] border border-[color:var(--color-border)]",
        "shadow-xl p-1.5",
      )}
    >
      {items.map((fi) => (
        <FlyoutItemButton key={fi.label} item={fi} onClick={() => onPick(fi)} />
      ))}
    </div>
  );
}

function FlyoutItemButton({ item, onClick }: { item: FlyoutItem; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      title={item.sublabel ? `${item.label} — ${item.sublabel}` : item.label}
      onClick={onClick}
      className={cn(
        "group/fi flex flex-col items-center justify-center",
        "h-14 w-14 rounded-lg transition gap-0.5",
        "text-[color:var(--color-fg-muted)]",
        "hover:bg-[color:var(--color-accent)] hover:text-white",
      )}
    >
      <Icon className="h-4 w-4" />
      <span className="text-[9px] font-medium leading-tight text-center px-1 truncate max-w-full">
        {shortLabel(item.label)}
      </span>
    </button>
  );
}

/** Shorten the label to fit a single 56px button line: keep the part after "·" if present. */
function shortLabel(full: string): ReactNode {
  const dot = full.indexOf("·");
  if (dot > 0) {
    return full.slice(dot + 1).trim();
  }
  // "Upload Image" → "Upload"
  const space = full.indexOf(" ");
  if (space > 0 && full.length > 8) return full.slice(0, space);
  return full;
}
