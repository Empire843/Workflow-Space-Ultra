"use client";

import {
  ArrowLeftRight,
  ChevronsUp,
  Eraser,
  Film,
  Frame,
  Image as ImageIcon,
  Music,
  Search,
  Sparkles,
  Type,
  Upload,
  Video,
  Wand2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { NODE_CATALOG, type NodeCatalogEntry } from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { useWorkflowStore } from "@/state/workflowStore";

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

const GROUP_LABEL: Record<NodeCatalogEntry["group"], string> = {
  content: "Content",
  generation: "Generation",
  transformation: "Transformation",
  layout: "Layout",
};

const GROUP_ORDER: NodeCatalogEntry["group"][] = [
  "generation",
  "content",
  "transformation",
  "layout",
];

export interface QuickAddMenuProps {
  /** Viewport-relative pixel coordinates of the click. */
  screenX: number;
  screenY: number;
  /** React Flow world coordinates — where new nodes should be spawned. */
  flowX: number;
  flowY: number;
  onClose: () => void;
}

/**
 * Floating quick-add palette. Opened by right-clicking an empty spot on the
 * canvas. Fuzzy-searchable, keyboard-navigable (↑/↓/Enter/Esc). Spawned node
 * lands at the click location (not a random offset), so it feels direct.
 */
export default function QuickAddMenu({ screenX, screenY, flowX, flowY, onClose }: QuickAddMenuProps) {
  const addNode = useWorkflowStore((s) => s.addNode);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: screenX, top: screenY });

  // Filtered + flattened list used for keyboard navigation.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return NODE_CATALOG.filter((e) => {
      if (!q) return true;
      return (
        e.label.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        (e.description || "").toLowerCase().includes(q) ||
        (e.provider || "").toLowerCase().includes(q)
      );
    });
  }, [query]);

  // Reset active index when filter changes so the highlight stays in bounds.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Focus input on mount so typing starts filtering immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Flip the menu if it would overflow the viewport (keep a small margin).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = screenX;
    let top = screenY;
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    setPos({ left, top });
  }, [screenX, screenY, filtered.length]);

  // Close on outside click / Esc / scroll / resize.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const entry = filtered[activeIdx];
        if (entry) pick(entry);
      }
    };
    const onScroll = () => onClose();

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, activeIdx]);

  function pick(entry: NodeCatalogEntry) {
    addNode(entry.kind, { x: flowX, y: flowY });
    onClose();
  }

  // Group filtered entries for display.
  const groups = useMemo(() => {
    const byGroup = new Map<NodeCatalogEntry["group"], NodeCatalogEntry[]>();
    for (const e of filtered) {
      const arr = byGroup.get(e.group);
      if (arr) arr.push(e);
      else byGroup.set(e.group, [e]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, entries: byGroup.get(g)! }));
  }, [filtered]);

  // Build a flat index map so group-rendered rows can compute their activeIdx.
  const flatIndex = new Map<string, number>();
  filtered.forEach((e, i) => flatIndex.set(e.kind, i));

  return (
    <div
      ref={rootRef}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 w-72 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev-1)] shadow-2xl shadow-black/60 overflow-hidden"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[color:var(--color-border)]">
        <Search className="h-3.5 w-3.5 text-[color:var(--color-fg-dim)]" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to filter…"
          className="flex-1 bg-transparent outline-none text-xs text-[color:var(--color-fg)] placeholder:text-[color:var(--color-fg-dim)]"
        />
        <span className="text-[10px] text-[color:var(--color-fg-dim)]">↑↓ · Enter · Esc</span>
      </div>

      <div className="max-h-80 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <div className="px-3 py-4 text-xs text-[color:var(--color-fg-dim)] text-center">No match</div>
        )}
        {groups.map(({ group, entries }) => (
          <div key={group}>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)]">
              {GROUP_LABEL[group]}
            </div>
            {entries.map((entry) => {
              const Icon = ICON_MAP[entry.icon || "image"] || ImageIcon;
              const i = flatIndex.get(entry.kind) ?? -1;
              const active = i === activeIdx;
              return (
                <button
                  key={entry.kind}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pick(entry)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition",
                    active
                      ? "bg-[color:var(--color-accent-subtle)] text-[color:var(--color-fg)]"
                      : "hover:bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg)]",
                  )}
                >
                  <div
                    className={cn(
                      "h-6 w-6 rounded grid place-items-center shrink-0",
                      active
                        ? "bg-[color:var(--color-accent)]/20 text-[color:var(--color-accent)]"
                        : "bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)]",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{entry.label}</div>
                    {entry.description && (
                      <div className="text-[10px] text-[color:var(--color-fg-dim)] truncate">{entry.description}</div>
                    )}
                  </div>
                  {entry.provider && (
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[9px] font-medium shrink-0",
                        entry.provider === "veo"
                          ? "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                          : entry.provider === "grok"
                            ? "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                            : "bg-slate-500/15 text-slate-300 border border-slate-500/30",
                      )}
                    >
                      {entry.provider.toUpperCase()}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
