"use client";

import {
  ArrowLeftRight,
  ChevronsUp,
  Eraser,
  Film,
  Frame,
  Image as ImageIcon,
  Music,
  Sparkles,
  Type,
  Upload,
  Video,
  Wand2,
} from "lucide-react";
import { useState } from "react";

import { NODE_CATALOG, type NodeCatalogEntry } from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/state/workflowStore";

type Tab = "content" | "generation" | "transformation";

const TABS: { id: Tab; label: string }[] = [
  { id: "content", label: "Content" },
  { id: "generation", label: "Generation" },
  { id: "transformation", label: "Transformation" },
];

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  image: ImageIcon,
  video: Video,
  type: Type,
  music: Music,
  upload: Upload,
  wand: Wand2,
  film: Film,
  arrows: ArrowLeftRight,
  "chevrons-up": ChevronsUp,
  sparkles: Sparkles,
  eraser: Eraser,
  frame: Frame,
};

export default function NodePalette() {
  const [tab, setTab] = useState<Tab>("generation");
  const addNode = useWorkflowStore((s) => s.addNode);

  const entries = NODE_CATALOG.filter((e) => e.group === tab);

  const onDragStart = (e: React.DragEvent<HTMLDivElement>, entry: NodeCatalogEntry) => {
    e.dataTransfer.setData("application/wsu-node-kind", entry.kind);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <aside className="absolute top-12 right-0 bottom-0 z-20 w-80 bg-[color:var(--color-bg-elev-1)] border-l border-[color:var(--color-border)] flex flex-col">
      <div className="flex gap-1 p-3 border-b border-[color:var(--color-border)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 h-8 text-xs font-medium rounded-md transition",
              tab === t.id
                ? "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)]"
                : "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-2">
        {entries.map((entry) => {
          const Icon = ICON_MAP[entry.icon || "image"] || ImageIcon;
          return (
            <div
              key={entry.kind}
              draggable
              onDragStart={(e) => onDragStart(e, entry)}
              onDoubleClick={() =>
                addNode(entry.kind, { x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 })
              }
              className="group cursor-grab active:cursor-grabbing rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-2)] p-3 hover:border-[color:var(--color-accent)] hover:shadow-[0_0_0_1px_var(--color-accent)] transition"
            >
              <div className="flex items-start gap-2">
                <div className="h-8 w-8 rounded-md bg-[color:var(--color-bg-elev-1)] grid place-items-center text-[color:var(--color-accent)]">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-[color:var(--color-fg)] truncate">{entry.label}</div>
                  <div className="text-[10px] text-[color:var(--color-fg-muted)] line-clamp-2 mt-0.5">
                    {entry.description}
                  </div>
                </div>
              </div>
              {entry.provider && (
                <div className="mt-2">
                  <span
                    className={cn(
                      "inline-block px-1.5 py-0.5 rounded text-[9px] font-medium",
                      entry.provider === "veo"
                        ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                        : entry.provider === "grok"
                          ? "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                          : "bg-slate-500/15 text-slate-300 border border-slate-500/30"
                    )}
                  >
                    {entry.provider.toUpperCase()}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-[color:var(--color-border)]">
        <p className="text-[10px] text-[color:var(--color-fg-dim)]">
          Kéo thả node vào canvas, hoặc double-click để thêm. Nối output → input để dựng workflow.
        </p>
      </div>
    </aside>
  );
}
