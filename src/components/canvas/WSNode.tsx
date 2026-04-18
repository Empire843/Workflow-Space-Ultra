"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Play,
  Trash2,
  Type,
  Upload as UploadIcon,
  Video,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { type ReactNode } from "react";

import {
  NODE_CATALOG,
  type NodeCatalogEntry,
  type NodeDataBase,
  type OutputItem,
} from "@/lib/nodes";
import { cn } from "@/lib/utils";
import { runSingleNode } from "@/state/runWorkflow";
import { useWorkflowStore } from "@/state/workflowStore";

const VIDEO_MODE_LABELS: Record<string, string> = {
  "t2v.veo": "Text → Video (VEO)",
  "t2v.grok": "Text → Video (Grok)",
  "i2v.veo": "Image → Video (VEO)",
  "i2v.grok": "Image → Video (Grok)",
};

/**
 * Media frame sizes by aspect ratio.
 * Picsart-style: fixed frame, rounded border, media covers the frame (object-cover).
 */
const FRAME_DIMS: Record<string, { w: number; h: number }> = {
  "16:9": { w: 280, h: 158 },
  "9:16": { w: 180, h: 320 },
  "1:1": { w: 220, h: 220 },
  "4:3": { w: 240, h: 180 },
  "3:4": { w: 180, h: 240 },
  "21:9": { w: 320, h: 137 },
};

function resolveFrameDims(data: NodeDataBase): { w: number; h: number } {
  const ar = data.aspectRatio || "16:9";
  return FRAME_DIMS[ar] || FRAME_DIMS["16:9"];
}

export default function WSNode(props: NodeProps) {
  const { id, data, selected } = props;
  const d = data as NodeDataBase;
  const meta = NODE_CATALOG.find((c) => c.kind === d.kind);
  const removeNode = useWorkflowStore((s) => s.removeNode);
  const cloneNode = useWorkflowStore((s) => s.cloneNode);
  const selectNode = useWorkflowStore((s) => s.selectNode);

  const isContent = d.kind.startsWith("content.");
  const isText = d.kind === "content.text";
  const showInputHandle = !d.kind.startsWith("content.") || d.kind === "content.text";
  const showOutputHandle = !d.kind.startsWith("content.text") || d.kind === "content.text";
  const running = d.status === "running";
  const queued = d.status === "queued";
  const busy = running || queued;

  const genMode = d.genMode || meta?.defaultGenMode;
  const isGrokMode = genMode?.includes(".grok") ?? false;

  const hasImageRef = useWorkflowStore((s) => {
    if (d.kind !== "gen.video") return false;
    if (genMode === "i2v.veo" || genMode === "i2v.grok") return false;
    return s.edges
      .filter((e) => e.target === id)
      .some((e) => {
        const src = s.nodes.find((n) => n.id === e.source);
        if (!src) return false;
        const k = src.data.kind;
        return (
          k === "content.image" ||
          k === "content.upload" ||
          k === "gen.image" ||
          src.data.imageUrl ||
          src.data.imageMediaId
        );
      });
  });

  const hasOutput =
    (d.outputs && d.outputs.length > 0) ||
    !!d.videoUrl ||
    !!d.videoHdUrl ||
    !!d.imageUrl;

  /**
   * Check whether any upstream gen node is not yet `done`, to decide whether to enable
   * the "Run upstream + this" button. If every parent is a content node or already
   * done → the cascade button has no real effect; we still show it but disable it
   * to avoid confusion.
   */
  const hasPendingUpstream = useWorkflowStore((s) => {
    const parentIds = s.edges.filter((e) => e.target === id).map((e) => e.source);
    if (!parentIds.length) return false;
    // DFS to detect any upstream gen node that is not done and has no output yet.
    const seen = new Set<string>();
    const stack = [...parentIds];
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const p = s.nodes.find((n) => n.id === pid);
      if (!p) continue;
      const pd = p.data;
      const hasOut = !!(pd.imageUrl || pd.videoUrl || pd.imageMediaId || pd.uploadBase64 || (pd.outputs && pd.outputs.length));
      if (!pd.kind.startsWith("content.") && pd.status !== "done" && !hasOut) {
        return true;
      }
      // recurse up to ancestors (content chain or completed gen nodes)
      for (const e of s.edges) {
        if (e.target === pid) stack.push(e.source);
      }
    }
    return false;
  });

  const handleRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || isContent) return;
    await runSingleNode(id);
  };

  const handleRunCascade = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || isContent) return;
    await runSingleNode(id, { cascade: true });
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    removeNode(id);
  };

  const handleClone = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idx = Date.now() % 10; // small lateral offset
    cloneNode(id, (idx % 3) + 1);
  };

  const headerLabel = () => {
    if (d.kind === "gen.video" && genMode && VIDEO_MODE_LABELS[genMode]) {
      return VIDEO_MODE_LABELS[genMode];
    }
    return meta?.label || d.kind;
  };

  const frame = resolveFrameDims(d);

  return (
    <div
      onClick={() => selectNode(id)}
      className="group relative cursor-pointer"
    >
      <NodeLabel meta={meta} label={headerLabel()} status={d.status} statusLog={d.statusLog} hasImageRef={hasImageRef} provider={isGrokMode ? "grok" : meta?.provider} />

      {/* The framed card. Do NOT use `overflow-hidden` on the outer element because it
       * would clip half of the `+` handle (react-flow Position.Right/Left centers the
       * handle on the edge with translate(±50%, -50%) → half the handle sits outside
       * the card). Previously media nodes lost the output handle because OutputItemCard
       * `absolute inset-0` covered everything and the outer overflow-hidden clipped the
       * outer half → nothing left to drag. Now the outer card only keeps border/shadow/size,
       * while media clipping + corner rounding live inside the `.card-inner` child wrapper.
       */}
      <div
        className={cn(
          "relative rounded-2xl border transition",
          "bg-[color:var(--color-bg-elev-2)]",
          selected
            ? "border-[color:var(--color-accent)] shadow-[0_0_0_1px_var(--color-accent),0_10px_30px_-10px_rgba(236,72,153,0.6)]"
            : "border-[color:var(--color-border-strong)] hover:border-[color:var(--color-border)]",
          running && "ring-2 ring-pink-500/60",
          queued && "ring-2 ring-amber-400/60",
          d.status === "error" && "ring-2 ring-red-500/70"
        )}
        style={isText ? undefined : { width: frame.w, height: frame.h }}
      >
        {/* Handles rendered at the root — no longer clipped by overflow-hidden. */}
        {showInputHandle && (
          <Handle
            type="target"
            position={Position.Left}
            className="ws-handle ws-handle-in"
          >
            <span className="ws-handle-glyph">+</span>
          </Handle>
        )}
        {showOutputHandle && (
          <Handle
            type="source"
            position={Position.Right}
            className="ws-handle ws-handle-out"
          >
            <span className="ws-handle-glyph">+</span>
          </Handle>
        )}

        {/* Inner wrapper responsible for clipping media + rounded corners. */}
        <div className="relative w-full h-full rounded-2xl overflow-hidden">
          {isText ? (
            <TextCardBody data={d} />
          ) : (
            <MediaCardBody data={d} selected={selected} />
          )}
        </div>

        {/* Hover toolbar */}
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex justify-end p-1.5 transition pointer-events-none",
            "opacity-0 group-hover:opacity-100",
            (selected || busy) && "opacity-100"
          )}
        >
          <div
            className="pointer-events-auto flex items-center gap-0.5 rounded-lg bg-black/75 backdrop-blur-sm px-1 py-1 border border-white/10 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {!isContent && (
              <>
                <ToolIconButton
                  onClick={handleRun}
                  disabled={busy}
                  title={queued ? "Queued – waiting for slot" : "Run node hiện tại (không chạy upstream)"}
                  tone={running ? "accent" : queued ? "warn" : "default"}
                >
                  {running ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : queued ? (
                    <Clock className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )}
                </ToolIconButton>
                <ToolIconButton
                  onClick={handleRunCascade}
                  disabled={busy || !hasPendingUpstream}
                  title={
                    !hasPendingUpstream
                      ? "Tất cả upstream đã sẵn sàng — dùng nút Run bên trái"
                      : "Run upstream chưa xong rồi chạy node này"
                  }
                  tone={running ? "accent" : "default"}
                >
                  <WorkflowIcon className="h-3.5 w-3.5" />
                </ToolIconButton>
              </>
            )}
            {hasOutput && <DownloadToolButton data={d} />}
            <ToolIconButton onClick={handleClone} title="Duplicate node">
              <Copy className="h-3.5 w-3.5" />
            </ToolIconButton>
            <ToolIconButton onClick={handleDelete} title="Delete node" tone="danger">
              <Trash2 className="h-3.5 w-3.5" />
            </ToolIconButton>
          </div>
        </div>

        {/* Progress bar pinned to bottom of card */}
        {(running || queued) && typeof d.progress === "number" && (
          <div className="absolute left-0 right-0 bottom-0 h-1 bg-black/40 overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                queued
                  ? "bg-amber-400/70 w-full animate-pulse"
                  : "bg-gradient-to-r from-pink-500 to-rose-500"
              )}
              style={running ? { width: `${Math.min(100, Math.max(2, d.progress))}%` } : undefined}
            />
          </div>
        )}
      </div>

      {/* Error box below card */}
      {d.status === "error" && d.error && (
        <div
          className="mt-1.5 text-[10px] text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-1.5 break-words"
          style={{ maxWidth: isText ? 320 : Math.max(240, frame.w) }}
        >
          {d.error}
        </div>
      )}
    </div>
  );
}

function NodeLabel({
  meta,
  label,
  status,
  statusLog,
  hasImageRef,
  provider,
}: {
  meta?: NodeCatalogEntry;
  label: string;
  status?: string;
  statusLog?: string;
  hasImageRef: boolean;
  provider?: string;
}) {
  const Icon = pickLabelIcon(meta?.icon || "image");
  const running = status === "running";
  const queued = status === "queued";
  return (
    <div className="flex items-center gap-1.5 mb-1.5 px-0.5 text-[color:var(--color-fg)]">
      <StatusDot status={status} fallback={<Icon className="h-3.5 w-3.5 text-[color:var(--color-fg-muted)]" />} />
      <span className="text-[12px] font-medium truncate max-w-[240px]">{label}</span>
      {provider && (
        <span className="shrink-0 px-1 py-px rounded text-[8px] font-semibold bg-white/5 text-[color:var(--color-fg-dim)] border border-white/10 uppercase tracking-wider">
          {provider}
        </span>
      )}
      {hasImageRef && (
        <span className="shrink-0 px-1 py-px rounded text-[8px] font-medium bg-violet-500/20 text-violet-300 border border-violet-500/30">
          + img ref
        </span>
      )}
      {(running || queued) && statusLog && (
        <span className="text-[9px] text-[color:var(--color-fg-muted)] italic truncate max-w-[160px]">
          {statusLog}
        </span>
      )}
    </div>
  );
}

function pickLabelIcon(name: string) {
  switch (name) {
    case "type":
      return Type;
    case "music":
      return Music;
    case "upload":
      return UploadIcon;
    case "video":
      return Video;
    case "film":
      return Film;
    case "image":
    default:
      return ImageIcon;
  }
}

function StatusDot({ status, fallback }: { status?: string; fallback?: ReactNode }) {
  if (status === "queued")
    return <Clock className="h-3.5 w-3.5 text-amber-400 animate-pulse" />;
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 text-[color:var(--color-accent)] animate-spin" />;
  if (status === "done")
    return <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--color-ok)]" />;
  if (status === "error")
    return <AlertTriangle className="h-3.5 w-3.5 text-red-400" />;
  return <>{fallback ?? <div className="h-2 w-2 rounded-full bg-[color:var(--color-fg-dim)]" />}</>;
}

function ToolIconButton({
  children,
  onClick,
  disabled,
  title,
  tone = "default",
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  tone?: "default" | "danger" | "accent" | "warn";
}) {
  const toneCls =
    tone === "danger"
      ? "text-white/80 hover:bg-red-500/30 hover:text-red-300"
      : tone === "accent"
        ? "text-[color:var(--color-accent)]"
        : tone === "warn"
          ? "text-amber-400"
          : "text-white/80 hover:bg-white/10 hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "h-7 w-7 grid place-items-center rounded-md transition disabled:opacity-40 disabled:cursor-not-allowed",
        toneCls
      )}
    >
      {children}
    </button>
  );
}

function DownloadToolButton({ data }: { data: NodeDataBase }) {
  const item: OutputItem | null =
    data.outputs && data.outputs.length > 0
      ? data.outputs[0]
      : data.videoUrl || data.videoHdUrl
        ? { videoUrl: data.videoUrl, videoHdUrl: data.videoHdUrl }
        : data.imageUrl
          ? { imageUrl: data.imageUrl, imageMediaId: data.imageMediaId }
          : null;
  if (!item) return null;
  const isVideo = Boolean(item.videoUrl || item.videoHdUrl);
  const raw = item.videoHdUrl || item.videoUrl || item.imageUrl || "";
  const ext = isVideo ? "mp4" : inferImageExt(item.mimeType, item.imageUrl);
  const filename = `${data.kind.replace(/\./g, "_")}.${ext}`;
  const href =
    raw.startsWith("/") || raw.startsWith("data:") || raw.startsWith("blob:")
      ? raw
      : `/api/download?url=${encodeURIComponent(raw)}&filename=${encodeURIComponent(filename)}`;
  return (
    <ToolIconButton
      title={`Download ${filename}`}
      onClick={(e) => {
        e.stopPropagation();
        triggerSave(href, filename);
      }}
    >
      <Download className="h-3.5 w-3.5" />
    </ToolIconButton>
  );
}

/* -------------------------------------------------------------------------- */
/*                                Card bodies                                 */
/* -------------------------------------------------------------------------- */

function MediaCardBody({ data, selected }: { data: NodeDataBase; selected?: boolean }) {
  const item: OutputItem | null =
    data.outputs && data.outputs.length > 0
      ? data.outputs[0]
      : data.videoUrl || data.videoHdUrl
        ? { videoUrl: data.videoUrl, videoHdUrl: data.videoHdUrl }
        : data.imageUrl
          ? { imageUrl: data.imageUrl, imageMediaId: data.imageMediaId }
          : null;

  if (!item) {
    return <EmptyPlaceholder data={data} />;
  }

  return <OutputItemCard item={item} nodeKind={data.kind} selected={selected} />;
}

function TextCardBody({ data }: { data: NodeDataBase }) {
  const preview = (data.effectiveText || data.text || "").trim();
  return (
    <div
      className="w-[240px] min-h-[88px] max-h-[200px] p-3 text-[12px] leading-relaxed text-[color:var(--color-fg)] whitespace-pre-wrap overflow-y-auto"
    >
      {preview ? (
        preview
      ) : (
        <span className="italic text-[color:var(--color-fg-dim)]">
          Click node to add text…
        </span>
      )}
    </div>
  );
}

/**
 * Picsart-style empty placeholder for nodes without output yet.
 * Sizes to fill the parent frame (absolute/0) so media swap keeps the same box.
 */
function EmptyPlaceholder({ data }: { data: NodeDataBase }) {
  const { kind } = data;

  if (kind === "content.upload") {
    return (
      <MediaPlaceholder
        icon={<UploadIcon className="h-7 w-7" />}
        title="Upload file"
        subtitle="Click node to pick a file"
      />
    );
  }

  if (kind === "content.audio" || data.audioUrl) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)] text-[11px]">
        <div className="flex items-center gap-1.5">
          <Music className="h-4 w-4" /> audio ready
        </div>
      </div>
    );
  }

  const isVideo = kind.includes("video") || kind.includes("start-end");
  const isImage = kind.includes("image");
  const icon = isVideo ? (
    <Video className="h-7 w-7" />
  ) : isImage ? (
    <ImageIcon className="h-7 w-7" />
  ) : (
    <Film className="h-7 w-7" />
  );
  const title = isVideo ? "Add a video" : isImage ? "Add an image" : "Add content";

  return (
    <MediaPlaceholder
      icon={icon}
      title={title}
      subtitle="Upload your own or generate with AI"
    />
  );
}

function MediaPlaceholder({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[color:var(--color-bg-elev-2)] text-[color:var(--color-fg-muted)]">
      <div className="flex flex-col items-center gap-1.5 px-3 text-center">
        <div className="h-10 w-10 rounded-full bg-[color:var(--color-bg-elev-1)] grid place-items-center text-[color:var(--color-fg-dim)]">
          {icon}
        </div>
        <div className="text-[11px] font-semibold text-[color:var(--color-fg)]">{title}</div>
        {subtitle && (
          <div className="text-[9px] text-[color:var(--color-fg-dim)] leading-tight">{subtitle}</div>
        )}
      </div>
    </div>
  );
}

function proxyIfExternal(url: string | undefined, filename: string): string {
  if (!url) return "";
  if (url.startsWith("/") || url.startsWith("data:") || url.startsWith("blob:")) return url;
  return `/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
}

function OutputItemCard({
  item,
  nodeKind,
  selected,
}: {
  item: OutputItem;
  nodeKind: string;
  selected?: boolean;
}) {
  const isVideo = Boolean(item.videoUrl || item.videoHdUrl);
  const filenameBase = nodeKind.replace(/\./g, "_");
  const ext = isVideo ? "mp4" : inferImageExt(item.mimeType, item.imageUrl);

  /**
   * When the node is NOT selected:
   *  - Video uses pointer-events-none → clicks on the card are received by React Flow to select the node.
   *  - Autoplay (muted, loop) acts as a silent preview.
   * When the node IS selected:
   *  - Enable <video controls> so the user can play/pause/seek/unmute.
   *  - pointer-events are re-enabled on the video.
   */
  return (
    <div
      className={cn(
        "absolute inset-0 bg-black",
        !selected && "pointer-events-none"
      )}
    >
      {isVideo ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={proxyIfExternal(item.videoHdUrl || item.videoUrl, `${filenameBase}.mp4`)}
          className="w-full h-full object-cover"
          autoPlay={!selected}
          muted={!selected}
          loop={!selected}
          playsInline
          controls={selected}
          onClick={(e) => {
            if (selected) e.stopPropagation();
          }}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={proxyIfExternal(item.imageUrl, `${filenameBase}.${ext}`)}
          alt="output"
          className="w-full h-full object-cover"
          draggable={false}
        />
      )}
    </div>
  );
}

function triggerSave(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  a.target = "_self";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function inferImageExt(mime?: string, url?: string): string {
  if (mime) {
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("webp")) return "webp";
  }
  if (url) {
    if (url.startsWith("data:image/png")) return "png";
    if (url.startsWith("data:image/jpeg")) return "jpg";
    if (url.startsWith("data:image/webp")) return "webp";
    const m = url.match(/\.(png|jpg|jpeg|webp)(\?|$)/i);
    if (m) return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  }
  return "png";
}
