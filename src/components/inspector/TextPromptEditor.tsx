"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import { useWorkflowStore } from "@/state/workflowStore";

/**
 * Text prompt editor for `content.text` nodes.
 *
 * Renders upstream (merged) text inline as read-only cyan-colored text followed
 * by the user's editable own text — all inside a single contentEditable frame.
 *
 * Upstream text is a non-editable <span contentEditable={false}> so the user
 * cannot modify it; own text is a regular editable <span>. We preserve caret
 * position across re-renders by writing directly to DOM instead of rerendering
 * the editable span on every keystroke.
 */
export default function TextPromptEditor({ nodeId }: { nodeId: string }) {
  const own = useWorkflowStore((s) => {
    const n = s.nodes.find((x) => x.id === nodeId);
    return (n?.data.text as string) || "";
  });
  const upstreamText = useWorkflowStore((s) => {
    const visited = new Set<string>();
    const walk = (id: string): string => {
      if (visited.has(id)) return "";
      visited.add(id);
      const n = s.nodes.find((x) => x.id === id);
      if (!n || n.data.kind !== "content.text") return "";
      const parents = s.edges.filter((e) => e.target === id).map((e) => e.source);
      const acc = parents
        .map((pid) => {
          const parent = s.nodes.find((x) => x.id === pid);
          if (!parent) return "";
          if (parent.data.kind === "content.text") {
            const parentUpstream = walk(pid);
            const parentOwn = ((parent.data.text as string) || "").trim();
            return [parentUpstream, parentOwn].filter(Boolean).join("\n");
          }
          return "";
        })
        .map((s2) => s2.trim())
        .filter(Boolean);
      return acc.join("\n");
    };
    return walk(nodeId);
  });
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const editableRef = useRef<HTMLSpanElement | null>(null);
  const lastSyncedOwn = useRef<string>(own);

  // Sync external `own` changes (e.g. from a different node / load) into DOM
  // without clobbering caret during typing.
  useLayoutEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    const cur = el.textContent || "";
    if (own !== cur && own !== lastSyncedOwn.current) {
      el.textContent = own;
      lastSyncedOwn.current = own;
    }
  }, [own]);

  // Initial mount: set content once.
  useEffect(() => {
    const el = editableRef.current;
    if (el && el.textContent !== own) {
      el.textContent = own;
      lastSyncedOwn.current = own;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When node switches, reset editable span text.
  useEffect(() => {
    const el = editableRef.current;
    if (el) {
      el.textContent = own;
      lastSyncedOwn.current = own;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const handleInput = () => {
    const el = editableRef.current;
    if (!el) return;
    const text = el.textContent || "";
    lastSyncedOwn.current = text;
    updateNodeData(nodeId, { text });
  };

  // Click anywhere in the outer box → focus the editable span at end.
  const focusEditable = () => {
    const el = editableRef.current;
    if (!el) return;
    el.focus();
    // Place caret at end.
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  return (
    <div
      ref={rootRef}
      onClick={focusEditable}
      className="rounded-lg border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-elev-2)] focus-within:border-[color:var(--color-accent)] transition p-3 text-sm leading-relaxed whitespace-pre-wrap cursor-text min-h-[64px]"
    >
      {upstreamText && (
        <span
          contentEditable={false}
          className="text-cyan-400 select-text whitespace-pre-wrap"
          title="Merged text from upstream (read-only)"
        >
          {upstreamText}
          {"\n"}
        </span>
      )}
      <span
        ref={editableRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        data-placeholder={upstreamText ? "Add your own text here…" : "Enter a prompt…"}
        className="outline-none text-[color:var(--color-fg)] empty:before:content-[attr(data-placeholder)] empty:before:text-[color:var(--color-fg-dim)] empty:before:italic"
      />
    </div>
  );
}
