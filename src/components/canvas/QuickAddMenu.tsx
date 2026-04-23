"use client";

import {
  ArrowLeftRight,
  ChevronsUp,
  Eraser,
  Film,
  Frame,
  Image as ImageIcon,
  ListPlus,
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
  "list-plus": ListPlus,
};

/**
 * Special non-catalog actions shown at the top of the quick-add menu. These
 * don't map to a single node kind — they open a dedicated flow (e.g. the
 * Scenes Import dialog spawns a whole batch of nodes + edges).
 */
type QuickAction = {
  id: "scenes-import" | "clone-video";
  label: string;
  description?: string;
  icon: keyof typeof ICON_MAP;
};

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "scenes-import",
    label: "Import scenes from prompts…",
    description: "Paste 2 cột prompt song song để tạo batch scene (Text → Image → Video)",
    icon: "list-plus",
  },
  {
    id: "clone-video",
    label: "Clone video…",
    description: "Upload video → AI phân tích → tự tạo workflow scene (Image → Video)",
    icon: "film",
  },
];

type FlatItem =
  | { type: "action"; action: QuickAction }
  | { type: "entry"; entry: NodeCatalogEntry };

const GROUP_LABEL: Record<NodeCatalogEntry["group"] | "actions", string> = {
  actions: "Actions",
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
  /** Open the Scenes Import dialog anchored at (flowX, flowY). */
  onOpenScenesImport?: (flowX: number, flowY: number) => void;
  /** Open the Analyze Video (Clone) dialog. */
  onOpenAnalyzeVideo?: () => void;
}

/**
 * Floating quick-add palette. Opened by right-clicking an empty spot on the
 * canvas. Fuzzy-searchable, keyboard-navigable (↑/↓/Enter/Esc). Spawned node
 * lands at the click location (not a random offset), so it feels direct.
 */
export default function QuickAddMenu({
  screenX,
  screenY,
  flowX,
  flowY,
  onClose,
  onOpenScenesImport,
  onOpenAnalyzeVideo,
}: QuickAddMenuProps) {
  const addNode = useWorkflowStore((s) => s.addNode);

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: screenX, top: screenY });

  // Filtered + flattened list used for keyboard navigation.
  // Actions (non-catalog quick entries) come first so they're easy to reach
  // when the menu opens with no query.
  const filtered = useMemo<FlatItem[]>(() => {
    const q = query.trim().toLowerCase();
    const actions: FlatItem[] = QUICK_ACTIONS.filter((a) => {
      if (!q) return true;
      return (
        a.label.toLowerCase().includes(q) ||
        (a.description || "").toLowerCase().includes(q)
      );
    }).map((action) => ({ type: "action", action }));
    const entries: FlatItem[] = NODE_CATALOG.filter((e) => {
      if (!q) return true;
      return (
        e.label.toLowerCase().includes(q) ||
        e.kind.toLowerCase().includes(q) ||
        (e.description || "").toLowerCase().includes(q) ||
        (e.provider || "").toLowerCase().includes(q)
      );
    }).map((entry) => ({ type: "entry", entry }));
    return [...actions, ...entries];
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
      } else       if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[activeIdx];
        if (item) pickItem(item);
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

  function pickItem(item: FlatItem) {
    if (item.type === "action") {
      if (item.action.id === "scenes-import") {
        onOpenScenesImport?.(flowX, flowY);
      } else if (item.action.id === "clone-video") {
        onOpenAnalyzeVideo?.();
      }
      onClose();
      return;
    }
    addNode(item.entry.kind, { x: flowX, y: flowY });
    onClose();
  }

  // Group filtered items for display. Actions always render in their own
  // pinned "Actions" group at the top.
  const actionItems = useMemo(
    () => filtered.filter((f): f is Extract<FlatItem, { type: "action" }> => f.type === "action"),
    [filtered],
  );
  const entryGroups = useMemo(() => {
    const entryItems = filtered.filter(
      (f): f is Extract<FlatItem, { type: "entry" }> => f.type === "entry",
    );
    const byGroup = new Map<NodeCatalogEntry["group"], NodeCatalogEntry[]>();
    for (const e of entryItems) {
      const arr = byGroup.get(e.entry.group);
      if (arr) arr.push(e.entry);
      else byGroup.set(e.entry.group, [e.entry]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, entries: byGroup.get(g)! }));
  }, [filtered]);

  // Build a flat index map so group-rendered rows can compute their activeIdx.
  // Key uses a prefix so action ids don't collide with node kinds.
  const flatIndex = new Map<string, number>();
  filtered.forEach((item, i) => {
    const key = item.type === "action" ? `a:${item.action.id}` : `e:${item.entry.kind}`;
    flatIndex.set(key, i);
  });

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
        {actionItems.length > 0 && (
          <div key="actions">
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)]">
              {GROUP_LABEL.actions}
            </div>
            {actionItems.map(({ action }) => {
              const Icon = ICON_MAP[action.icon] || ListPlus;
              const i = flatIndex.get(`a:${action.id}`) ?? -1;
              const active = i === activeIdx;
              return (
                <button
                  key={action.id}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pickItem({ type: "action", action })}
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
                    <div className="text-xs font-medium truncate">{action.label}</div>
                    {action.description && (
                      <div className="text-[10px] text-[color:var(--color-fg-dim)] truncate">
                        {action.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {entryGroups.map(({ group, entries }) => (
          <div key={group}>
            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)]">
              {GROUP_LABEL[group]}
            </div>
            {entries.map((entry) => {
              const Icon = ICON_MAP[entry.icon || "image"] || ImageIcon;
              const i = flatIndex.get(`e:${entry.kind}`) ?? -1;
              const active = i === activeIdx;
              return (
                <button
                  key={entry.kind}
                  type="button"
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => pickItem({ type: "entry", entry })}
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
