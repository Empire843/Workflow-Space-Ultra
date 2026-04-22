"use client";

import { Loader2, Send, Sparkles, Upload as UploadIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { NODE_CATALOG, type GenMode, type NodeDataBase } from "@/lib/nodes";
import {
  VEO_I2V_DEFAULT_LABEL,
  VEO_I2V_MODELS,
  VEO_T2V_DEFAULT_LABEL,
  VEO_T2V_MODELS,
  getCreditsFor,
} from "@/lib/veoVideoModels";
import { cn } from "@/lib/utils";
import { runSingleNode } from "@/state/runWorkflow";
import { useWorkflowStore } from "@/state/workflowStore";

import TextPromptEditor from "./TextPromptEditor";

// ---------------------------------------------------------------------------
// Constants for dropdowns
// ---------------------------------------------------------------------------

// Only T2V.* modes are exposed — connecting an image node upstream flips the
// generation into I2V automatically at run time, so the previously separate
// `i2v.*` entries would have been redundant.
const VIDEO_GEN_MODE_OPTIONS: { value: GenMode; label: string }[] = [
  { value: "t2v.veo", label: "Video (VEO)" },
  { value: "t2v.grok", label: "Video (Grok)" },
];

const IMAGE_MODEL_OPTIONS = [
  "Nano Banana 2",
  "Nano Banana pro",
  "Nano Banana",
  "Imagen 4",
];

const ASPECT_OPTIONS = ["16:9", "9:16", "1:1"];
const GROK_RESOLUTIONS = ["480p", "720p"];
/**
 * Grok Imagine requires videoLength ∈ [1..10] seconds (integer).
 * Keep common presets — default 6s.
 */
const GROK_LENGTHS = [4, 6, 8, 10];

/**
 * Grok video models. Currently Grok only has "Grok Imagine" — kept as a
 * list so it's easy to extend when xAI adds other models (e.g. Imagine Pro).
 */
const GROK_VIDEO_MODELS: { label: string; hint?: string }[] = [
  { label: "Grok Imagine", hint: "Free with Grok Heavy" },
];
const GROK_VIDEO_DEFAULT_LABEL = GROK_VIDEO_MODELS[0].label;

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

export default function NodeInspector() {
  const selectedId = useWorkflowStore((s) => s.selectedNodeId);
  const node = useWorkflowStore((s) =>
    selectedId ? s.nodes.find((n) => n.id === selectedId) : null
  );

  if (!selectedId || !node) return null;

  // `pointer-events-none` on the wrapper + `pointer-events-auto` on the card
  // means the empty area around the inspector (same DOM rect as the wrapper)
  // does not intercept pointer events. Without this, releasing the mouse over
  // that transparent margin while dragging a node would swallow React Flow's
  // pointerup and leave the node stuck to the cursor.
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(840px,calc(100%-24rem))]">
      <div className="pointer-events-auto rounded-2xl bg-[color:var(--color-bg-elev-1)]/95 backdrop-blur border border-[color:var(--color-border-strong)] shadow-2xl shadow-black/60">
        <InspectorHeader node={node} />
        <div className="p-3 space-y-3">
          {node.data.origin === "mcp" && (
            <McpProvenanceBanner nodeId={selectedId} data={node.data} />
          )}
          <InspectorBody nodeId={selectedId} data={node.data} />
        </div>
      </div>
    </div>
  );
}

function InspectorHeader({ node }: { node: { id: string; data: NodeDataBase } }) {
  const meta = NODE_CATALOG.find((c) => c.kind === node.data.kind);
  const selectNode = useWorkflowStore((s) => s.selectNode);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-[color:var(--color-border)]">
      <div className="flex items-center gap-2 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)]">
          {meta?.group || "Node"}
        </div>
        <div className="text-sm font-semibold truncate">{meta?.label || node.data.kind}</div>
      </div>
      <button
        type="button"
        onClick={() => selectNode(null)}
        title="Close inspector"
        className="h-6 w-6 grid place-items-center rounded text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-elev-2)] hover:text-[color:var(--color-fg)]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP provenance banner
// ---------------------------------------------------------------------------
//
// Rendered at the top of the inspector body when a node was synthesised by
// the MCP server (see src/server/mcp/snapshotWriter.ts). Offers the user a
// one-click "downgrade" into a content reference node: strip the generation
// config (prompt/model/etc.) but keep the produced asset. Useful when the
// user wants the generated image/video on the canvas as a static input to
// another pipeline step rather than as an editable generation spec.
//
function McpProvenanceBanner({
  nodeId,
  data,
}: {
  nodeId: string;
  data: NodeDataBase;
}) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  const firstOutput = data.outputs?.[0];
  const hasImage = Boolean(firstOutput?.imageUrl ?? data.imageUrl);
  const hasVideo = Boolean(firstOutput?.videoUrl ?? data.videoUrl);
  // Only offer the downgrade when there's actually an asset to preserve.
  const canDowngrade = hasImage || hasVideo;

  const handleDowngrade = () => {
    if (!canDowngrade) return;
    // Collapse the node to `content.upload` — the canvas uses that kind as
    // the generic "static asset reference" node. We explicitly undefine the
    // generation-only fields so the serializer strips them on next save
    // (Record<string, unknown> → missing keys ≠ `undefined` keys for JSON).
    updateNodeData(nodeId, {
      kind: "content.upload",
      status: "done",
      prompt: undefined,
      modelLabel: undefined,
      videoModelKey: undefined,
      aspectRatio: undefined,
      resolution: undefined,
      videoLength: undefined,
      outputCount: undefined,
      seed: undefined,
      genMode: undefined,
      origin: undefined,
      mcpJobId: undefined,
      mcpCreatedAt: undefined,
      // Preserve the asset URL(s) so the upload node renders the media.
      imageUrl: hasImage ? firstOutput?.imageUrl ?? data.imageUrl : undefined,
      videoUrl: hasVideo ? firstOutput?.videoUrl ?? data.videoUrl : undefined,
      uploadAccept: hasImage ? "image/*" : hasVideo ? "video/*" : undefined,
    });
  };

  return (
    <div className="flex items-start gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-[11px] text-sky-100">
      <Sparkles className="h-3.5 w-3.5 shrink-0 mt-0.5 text-sky-300" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">Tạo bởi MCP</div>
        <div className="text-sky-200/80 leading-snug">
          Node này được server tạo qua MCP tool. Bạn có thể giữ nguyên để re-run, hoặc chuyển thành tham chiếu tĩnh để dùng làm input cho node khác.
        </div>
      </div>
      <button
        type="button"
        onClick={handleDowngrade}
        disabled={!canDowngrade}
        className="shrink-0 h-7 px-2 rounded-md border border-sky-500/40 bg-sky-500/20 text-[10px] font-medium hover:bg-sky-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
        title={
          canDowngrade
            ? "Chuyển sang content reference (giữ media, xoá prompt/model)"
            : "Chưa có media để giữ lại"
        }
      >
        Convert to reference
      </button>
    </div>
  );
}

function InspectorBody({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  switch (data.kind) {
    case "content.text":
      return <TextNodeConfig nodeId={nodeId} />;
    case "content.upload":
      return <UploadNodeConfig nodeId={nodeId} data={data} />;
    case "content.image":
    case "content.video":
    case "content.audio":
      return (
        <div className="text-xs text-[color:var(--color-fg-muted)]">
          This node has no editable config.
        </div>
      );
    case "gen.image":
      return <ImageGenConfig nodeId={nodeId} data={data} />;
    case "gen.video":
      return <VideoGenConfig nodeId={nodeId} data={data} />;
    case "gen.start-end":
      return <StartEndGenConfig nodeId={nodeId} data={data} />;
    default:
      return (
        <div className="text-xs text-[color:var(--color-fg-muted)]">
          No inspector for this node kind yet.
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Text node
// ---------------------------------------------------------------------------

function TextNodeConfig({ nodeId }: { nodeId: string }) {
  return (
    <div className="space-y-2">
      <Label>Prompt</Label>
      <TextPromptEditor nodeId={nodeId} />
      <div className="text-[10px] text-[color:var(--color-fg-dim)]">
        Connect this text node to a generation node to use it as prompt.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload node
// ---------------------------------------------------------------------------

function UploadNodeConfig({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const activeWorkflowId = useWorkflowStore((s) => s.activeWorkflowId);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFile = async (file: File) => {
    const b64 = await fileToBase64(file);
    const dataUri = `data:${file.type};base64,${b64}`;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");

    // Optimistic update so the preview is instant. The data URI here gets
    // overwritten by the server URL below if the upload succeeds; it only
    // survives when there is no open workflow (ad-hoc canvas use).
    updateNodeData(nodeId, {
      uploadBase64: b64,
      uploadMime: file.type,
      uploadFilePath: file.name,
      imageUrl: isImage ? dataUri : undefined,
      videoUrl: isVideo ? dataUri : undefined,
      audioUrl: isAudio ? dataUri : undefined,
      status: "done",
    });

    // Persist to the workflow folder on disk so the preview still works after
    // a reload / account switch / workflow re-open. We upload in the
    // background — if it fails we keep the data URI so the user can still
    // iterate in this session.
    if (activeWorkflowId) {
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await fetch(
          `/api/workflows/${encodeURIComponent(activeWorkflowId)}/assets`,
          { method: "POST", body: form },
        );
        const json = (await res.json()) as {
          ok: boolean;
          url?: string;
          fileName?: string;
          message?: string;
        };
        if (json.ok && json.url) {
          updateNodeData(nodeId, {
            uploadFilePath: file.name,
            imageUrl: isImage ? json.url : undefined,
            videoUrl: isVideo ? json.url : undefined,
            audioUrl: isAudio ? json.url : undefined,
          });
        }
      } catch {
        // Silently ignored — the optimistic data URI above keeps the node
        // usable even if the write fails (e.g. disk full).
      }
    }
  };

  const hasFile = Boolean(data.uploadBase64 || data.imageUrl);
  const acceptHint = data.uploadAccept === "image/*"
    ? "image"
    : data.uploadAccept === "video/*"
      ? "video"
      : "file";

  return (
    <div className="space-y-2">
      <Label>Upload {acceptHint}</Label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs hover:bg-[color:var(--color-bg-elev-1)]"
        >
          <UploadIcon className="h-3.5 w-3.5" />
          {hasFile ? "Replace file" : "Choose file"}
        </button>
        {data.uploadFilePath && (
          <div className="text-[11px] text-[color:var(--color-fg-muted)] truncate max-w-[320px]">
            {data.uploadFilePath}
          </div>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        /* uploadAccept is set by the LeftToolbar flyout (image/* or video/*).
         * If not set, allow both types. */
        accept={data.uploadAccept || "image/*,video/*"}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// gen.image
// ---------------------------------------------------------------------------

/** Models that accept reference images — mirror of server MODEL_SUPPORTS_REFERENCE. */
const IMAGE_MODELS_SUPPORT_REFERENCE = new Set(["Nano Banana 2", "Nano Banana pro", "Nano Banana"]);

function ImageGenConfig({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

  // Collect upstream image node data refs for the preview row.
  //
  // IMPORTANT: the selector must return STABLE references across renders,
  // otherwise React + Zustand trigger "getSnapshot should be cached" (and
  // ultimately an infinite update loop). Pitfall: if the selector builds new
  // plain objects inside the array (e.g. `{ imageUrl: d.imageUrl, ... }`),
  // `useShallow` still sees them as different refs every call. The fix is to
  // return the ORIGINAL `data` refs from the store (those are only replaced
  // when `updateNodeData` runs) and let a `useMemo` project them into the
  // shape the UI consumes.
  const rawRefs = useWorkflowStore(
    useShallow((s): NodeDataBase[] => {
      const parentIds = s.edges.filter((e) => e.target === nodeId).map((e) => e.source);
      const refs: NodeDataBase[] = [];
      for (const pid of parentIds) {
        const d = s.nodes.find((n) => n.id === pid)?.data;
        if (!d) continue;
        if (!(d.imageUrl || d.imageMediaId || d.uploadBase64)) continue;
        refs.push(d);
      }
      return refs;
    })
  );

  const references = useMemo(
    () =>
      rawRefs.map((d) => ({
        url: d.imageUrl || (d.uploadBase64 ? `data:${d.uploadMime || "image/png"};base64,${d.uploadBase64}` : ""),
        label: d.label || d.kind,
      })),
    [rawRefs]
  );

  const modelLabel = data.modelLabel || "Nano Banana 2";
  const supportsRef = IMAGE_MODELS_SUPPORT_REFERENCE.has(modelLabel);

  useEffect(() => {
    if (!data.modelLabel) {
      updateNodeData(nodeId, { modelLabel: "Nano Banana 2" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  return (
    <div className="space-y-3">
      <div>
        <Label>Prompt</Label>
        <PromptTextarea nodeId={nodeId} value={data.prompt || ""} />
      </div>
      {references.length > 0 && (
        <div>
          <Label>
            References · {references.length}
            {!supportsRef && (
              <span className="ml-2 text-[10px] font-normal text-amber-400">
                {modelLabel} không hỗ trợ reference — ảnh sẽ bị bỏ qua. Chọn Nano Banana 2 / pro để dùng.
              </span>
            )}
          </Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {references.map((r, i) => (
              <div
                key={i}
                className={cn(
                  "relative h-12 w-12 rounded-md overflow-hidden border",
                  supportsRef ? "border-[color:var(--color-accent)]/50" : "border-amber-500/40 opacity-60",
                )}
                title={r.label}
              >
                {r.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.url} alt={r.label} className="h-full w-full object-cover" />
                ) : (
                  <div className="h-full w-full grid place-items-center text-[9px] text-[color:var(--color-fg-dim)]">?</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Model">
          <Select
            value={modelLabel}
            onChange={(v) => updateNodeData(nodeId, { modelLabel: v })}
            options={IMAGE_MODEL_OPTIONS.map((m) => ({ value: m, label: m }))}
          />
        </Field>
        <Field label="Aspect">
          <Select
            value={data.aspectRatio || "16:9"}
            onChange={(v) => updateNodeData(nodeId, { aspectRatio: v })}
            options={ASPECT_OPTIONS.map((a) => ({ value: a, label: a }))}
          />
        </Field>
        <Field label="Count">
          <NumberInput
            value={data.outputCount || 1}
            min={1}
            max={4}
            onChange={(v) => updateNodeData(nodeId, { outputCount: v })}
          />
        </Field>
        <GenerateButton nodeId={nodeId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// gen.video
// ---------------------------------------------------------------------------

function VideoGenConfig({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const genMode: GenMode = (data.genMode as GenMode) || "t2v.veo";
  const isGrok = genMode.includes(".grok");
  const isVeo = genMode.includes(".veo");

  // With the T2V/I2V merge, the generation mode no longer tells us whether
  // this is an I2V run — the upstream graph does. Peek at the incoming edges
  // and switch the VEO model list (T2V vs I2V) when any parent carries an
  // image, so the user sees the actual model set the executor will use.
  const hasImageUpstream = useWorkflowStore((s) => {
    const parents = s.edges.filter((e) => e.target === nodeId).map((e) => e.source);
    for (const pid of parents) {
      const d = s.nodes.find((n) => n.id === pid)?.data;
      if (d && (d.imageUrl || d.imageMediaId || d.uploadBase64)) return true;
    }
    return false;
  });
  const isI2V = hasImageUpstream;

  const veoModels = isI2V ? VEO_I2V_MODELS : VEO_T2V_MODELS;
  const veoDefault = isI2V ? VEO_I2V_DEFAULT_LABEL : VEO_T2V_DEFAULT_LABEL;
  const credits = isVeo
    ? getCreditsFor(veoModels, data.modelLabel, data.aspectRatio)
    : -1;

  // Persist the VEO default (Lower Priority · 0 cr) onto the node the first
  // time the inspector sees a VEO video node without a model label. Without
  // this, nodes spawned from LeftToolbar / ScenesImportDialog / MCP keep a
  // blank `modelLabel` on disk and the server falls back to its own picker
  // (which returns Fast · 20 cr for ULTRA accounts). Writing the default here
  // keeps the UI dropdown and the actual execution in sync.
  useEffect(() => {
    if (isVeo && !data.modelLabel) {
      updateNodeData(nodeId, { modelLabel: veoDefault });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, isVeo, isI2V]);

  /**
   * When genMode changes, also reset modelLabel to match the new provider.
   * Avoids a case where a VEO label (e.g. "VEO 3.1 Ultra (Fast)") lingers when
   * the user switches to Grok → the Grok dropdown can't find the label → incorrect
   * server-side modelKey resolution.
   */
  const handleModeChange = (newMode: GenMode) => {
    const wasGrok = genMode.includes(".grok");
    const goingGrok = newMode.includes(".grok");
    const goingVeo = newMode.includes(".veo");

    const patch: Partial<NodeDataBase> = { genMode: newMode, videoModelKey: undefined };

    if (wasGrok !== goingGrok) {
      if (goingGrok) {
        patch.modelLabel = GROK_VIDEO_DEFAULT_LABEL;
        if (!data.resolution) patch.resolution = "720p";
        const curLen = Number(data.videoLength) || 6;
        patch.videoLength = curLen >= 1 && curLen <= 10 ? curLen : 6;
      } else if (goingVeo) {
        patch.modelLabel = isI2V ? VEO_I2V_DEFAULT_LABEL : VEO_T2V_DEFAULT_LABEL;
      }
    }

    updateNodeData(nodeId, patch);
  };

  return (
    <div className="space-y-3">
      <div>
        <Label>Prompt</Label>
        <PromptTextarea nodeId={nodeId} value={data.prompt || ""} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Mode">
          <Select
            value={genMode}
            onChange={(v) => handleModeChange(v as GenMode)}
            options={VIDEO_GEN_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Field>

        {isVeo && (
          <Field label={`Model${credits >= 0 ? ` · ${credits} cr` : ""}`}>
            <Select
              value={data.modelLabel || veoDefault}
              onChange={(v) => updateNodeData(nodeId, { modelLabel: v, videoModelKey: undefined })}
              options={veoModels.map((m) => ({
                value: m.label,
                label: `${m.label} (${m.credits} cr)`,
              }))}
            />
          </Field>
        )}

        {isGrok && (
          <Field label="Model">
            <Select
              value={data.modelLabel || GROK_VIDEO_DEFAULT_LABEL}
              onChange={(v) => updateNodeData(nodeId, { modelLabel: v })}
              options={GROK_VIDEO_MODELS.map((m) => ({
                value: m.label,
                label: m.hint ? `${m.label} — ${m.hint}` : m.label,
              }))}
            />
          </Field>
        )}

        <Field label="Aspect">
          <Select
            value={data.aspectRatio || "16:9"}
            onChange={(v) => updateNodeData(nodeId, { aspectRatio: v })}
            options={ASPECT_OPTIONS.map((a) => ({ value: a, label: a }))}
          />
        </Field>

        {isGrok && (
          <>
            <Field label="Length">
              <Select
                value={String(data.videoLength || 6)}
                onChange={(v) => updateNodeData(nodeId, { videoLength: Number(v) })}
                options={GROK_LENGTHS.map((s) => ({ value: String(s), label: `${s}s` }))}
              />
            </Field>
            <Field label="Resolution">
              <Select
                value={data.resolution || "720p"}
                onChange={(v) => updateNodeData(nodeId, { resolution: v as "480p" | "720p" })}
                options={GROK_RESOLUTIONS.map((r) => ({ value: r, label: r }))}
              />
            </Field>
          </>
        )}

        {isVeo && (
          <Field label="Count">
            <NumberInput
              value={data.outputCount || 1}
              min={1}
              max={4}
              onChange={(v) => updateNodeData(nodeId, { outputCount: v })}
            />
          </Field>
        )}

        <GenerateButton nodeId={nodeId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// gen.start-end
// ---------------------------------------------------------------------------

function StartEndGenConfig({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const credits = getCreditsFor(VEO_I2V_MODELS, data.modelLabel, data.aspectRatio);

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-[color:var(--color-fg-muted)]">
        Connect 2 image nodes upstream (start + end frame).
      </div>
      <div>
        <Label>Prompt</Label>
        <PromptTextarea nodeId={nodeId} value={data.prompt || ""} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`Model${credits >= 0 ? ` · ${credits} cr` : ""}`}>
          <Select
            value={data.modelLabel || VEO_I2V_DEFAULT_LABEL}
            onChange={(v) => updateNodeData(nodeId, { modelLabel: v, videoModelKey: undefined })}
            options={VEO_I2V_MODELS.map((m) => ({
              value: m.label,
              label: `${m.label} (${m.credits} cr)`,
            }))}
          />
        </Field>
        <Field label="Aspect">
          <Select
            value={data.aspectRatio || "16:9"}
            onChange={(v) => updateNodeData(nodeId, { aspectRatio: v })}
            options={ASPECT_OPTIONS.map((a) => ({ value: a, label: a }))}
          />
        </Field>
        <Field label="Count">
          <NumberInput
            value={data.outputCount || 1}
            min={1}
            max={4}
            onChange={(v) => updateNodeData(nodeId, { outputCount: v })}
          />
        </Field>
        <GenerateButton nodeId={nodeId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)] mb-1">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-fg-dim)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
    >
      {options.map((o) => (
        <option
          key={o.value}
          value={o.value}
          className="bg-[color:var(--color-bg-elev-2)]"
        >
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({
  value,
  min = 1,
  max = 99,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const raw = parseInt(e.target.value, 10);
        if (Number.isNaN(raw)) return;
        onChange(Math.max(min, Math.min(max, raw)));
      }}
      className="h-8 w-16 px-2 rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] text-xs text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
    />
  );
}

function PromptTextarea({
  nodeId,
  value,
}: {
  nodeId: string;
  value: string;
}) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const inheritedText = useWorkflowStore((s) => {
    const visited = new Set<string>();
    const walk = (id: string): string => {
      if (visited.has(id)) return "";
      visited.add(id);
      const n = s.nodes.find((x) => x.id === id);
      if (!n) return "";
      if (n.data.kind !== "content.text") return "";
      const parents = s.edges.filter((e) => e.target === id).map((e) => e.source);
      const parts: string[] = [];
      for (const pid of parents) {
        const sub = walk(pid);
        if (sub) parts.push(sub);
      }
      const own = ((n.data.text as string) || "").trim();
      if (own) parts.push(own);
      return parts.join("\n");
    };
    const myParents = s.edges.filter((e) => e.target === nodeId).map((e) => e.source);
    return myParents
      .map((pid) => walk(pid))
      .map((t) => t.trim())
      .filter(Boolean)
      .join("\n");
  });

  /**
   * Self-heal for prompts contaminated by upstream text from an old bug (before the
   * executor stopped clobbering `prompt` with combined text). When value starts with
   * exactly `inheritedText` (with or without a trailing newline) → strip that part,
   * keeping only what the user typed. Runs once whenever `nodeId` / `inheritedText` /
   * `value` change; idempotent because after stripping, there's no matching prefix next time.
   */
  useEffect(() => {
    if (!inheritedText) return;
    if (!value) return;
    const trimmedVal = value.replace(/^\s+/, "");
    if (trimmedVal === inheritedText) {
      updateNodeData(nodeId, { prompt: "" });
      return;
    }
    const prefix = inheritedText + "\n";
    if (trimmedVal.startsWith(prefix)) {
      updateNodeData(nodeId, { prompt: trimmedVal.slice(prefix.length) });
    }
  }, [nodeId, inheritedText, value, updateNodeData]);

  return (
    <div className="space-y-1">
      {inheritedText && (
        <div className="rounded-md bg-cyan-500/10 border border-cyan-500/20 px-2 py-1.5 text-[11px] text-cyan-300 whitespace-pre-wrap leading-relaxed">
          <span className="text-[9px] uppercase tracking-wider text-cyan-400/70 block mb-0.5">
            From upstream (read-only)
          </span>
          {inheritedText}
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => updateNodeData(nodeId, { prompt: e.target.value })}
        placeholder={inheritedText ? "Add more prompt text…" : "Describe what you want to generate…"}
        rows={3}
        className="w-full rounded-md bg-[color:var(--color-bg-elev-2)] border border-[color:var(--color-border)] px-2 py-2 text-sm text-[color:var(--color-fg)] placeholder:text-[color:var(--color-fg-dim)] outline-none focus:border-[color:var(--color-accent)] resize-none leading-relaxed"
      />
    </div>
  );
}

function GenerateButton({ nodeId }: { nodeId: string }) {
  const status = useWorkflowStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.status);
  const running = status === "running" || status === "queued";

  const label = useMemo(() => {
    if (status === "running") return "Running…";
    if (status === "queued") return "Queued…";
    return "Generate";
  }, [status]);

  /**
   * Mirror the canvas Play button (`runSingleNode(id)` with `cascade=false`)
   * so clicking Generate from the inspector only re-runs **this** node and
   * reuses whatever output upstream nodes already have. The previous
   * default of `cascade: true` would force every upstream gen node to be
   * cleared and re-run, which surprised users (and burned credits) when
   * they opened the inspector just to tweak a downstream parameter on a
   * graph whose earlier nodes were already done.
   *
   * Power users can still opt into the full chain refresh with Shift+Click
   * — same semantics as the Workflow icon button on the canvas.
   */
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const cascade = e.shiftKey;
    void runSingleNode(nodeId, { cascade });
  };

  return (
    <button
      type="button"
      disabled={running}
      onClick={handleClick}
      title="Generate node hiện tại — Shift+Click để re-run toàn bộ upstream"
      className={cn(
        "ml-auto h-8 px-4 rounded-lg bg-gradient-to-r from-pink-500 to-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 transition",
        running ? "opacity-70 cursor-not-allowed" : "hover:opacity-95 shadow-lg shadow-pink-500/20"
      )}
    >
      {running ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Send className="h-3.5 w-3.5" />
      )}
      {label}
    </button>
  );
}
