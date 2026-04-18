"use client";

import { Loader2, Send, Upload as UploadIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { NODE_CATALOG, type GenMode, type NodeDataBase } from "@/lib/nodes";
import {
  VEO_I2V_MODELS,
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

const VIDEO_GEN_MODE_OPTIONS: { value: GenMode; label: string }[] = [
  { value: "t2v.veo", label: "Text → Video (VEO)" },
  { value: "t2v.grok", label: "Text → Video (Grok)" },
  { value: "i2v.veo", label: "Image → Video (VEO)" },
  { value: "i2v.grok", label: "Image → Video (Grok)" },
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

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 w-[min(840px,calc(100%-24rem))]">
      <div className="rounded-2xl bg-[color:var(--color-bg-elev-1)]/95 backdrop-blur border border-[color:var(--color-border-strong)] shadow-2xl shadow-black/60">
        <InspectorHeader node={node} />
        <div className="p-3 space-y-3">
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
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleFile = async (file: File) => {
    const b64 = await fileToBase64(file);
    const dataUri = `data:${file.type};base64,${b64}`;
    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    updateNodeData(nodeId, {
      uploadBase64: b64,
      uploadMime: file.type,
      uploadFilePath: file.name,
      imageUrl: isImage ? dataUri : undefined,
      videoUrl: isVideo ? dataUri : undefined,
      audioUrl: isAudio ? dataUri : undefined,
      status: "done",
    });
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

function ImageGenConfig({ nodeId, data }: { nodeId: string; data: NodeDataBase }) {
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);

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
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Model">
          <Select
            value={data.modelLabel || "Nano Banana 2"}
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
  const isI2V = genMode.startsWith("i2v.");

  const veoModels = isI2V ? VEO_I2V_MODELS : VEO_T2V_MODELS;
  const veoDefault = veoModels[1]?.label || veoModels[0].label; // Ultra Fast as default
  const credits = isVeo
    ? getCreditsFor(veoModels, data.modelLabel, data.aspectRatio)
    : -1;

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
    const goingI2V = newMode.startsWith("i2v.");

    const patch: Partial<NodeDataBase> = { genMode: newMode, videoModelKey: undefined };

    if (wasGrok !== goingGrok) {
      // Switching provider family → reset label to provider's default
      if (goingGrok) {
        patch.modelLabel = GROK_VIDEO_DEFAULT_LABEL;
        // Ensure Grok-specific fields have sane defaults; clamp length to [1,10]
        if (!data.resolution) patch.resolution = "720p";
        const curLen = Number(data.videoLength) || 6;
        patch.videoLength = curLen >= 1 && curLen <= 10 ? curLen : 6;
      } else if (goingVeo) {
        const targetModels = goingI2V ? VEO_I2V_MODELS : VEO_T2V_MODELS;
        patch.modelLabel = targetModels[1]?.label || targetModels[0].label;
      }
    } else if (goingVeo) {
      // Same provider (VEO) but t2v ↔ i2v → remap model label to matching list
      const targetModels = goingI2V ? VEO_I2V_MODELS : VEO_T2V_MODELS;
      if (!targetModels.find((m) => m.label === data.modelLabel)) {
        patch.modelLabel = targetModels[1]?.label || targetModels[0].label;
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
            value={data.modelLabel || VEO_I2V_MODELS[1].label}
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

  return (
    <button
      type="button"
      disabled={running}
      onClick={() => void runSingleNode(nodeId, { cascade: true })}
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
