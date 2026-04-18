/**
 * Definitions for the node kinds used on the canvas.
 * Each node has a single data object holding config + output.
 */

export type ProviderId = "veo" | "grok" | "local";

export type GenMode =
  | "t2i.veo"
  | "t2v.veo"
  | "t2v.grok"
  | "i2v.veo"
  | "i2v.grok";

export type NodeKind =
  // Content
  | "content.image"
  | "content.video"
  | "content.text"
  | "content.audio"
  | "content.upload"
  // Generation (generic — sub-type via `data.genMode`)
  | "gen.image"
  | "gen.video"
  | "gen.start-end"
  // Transformation
  | "xform.upscale.grok"
  | "xform.enhance"
  | "xform.remove-bg"
  | "xform.extract-frames";

export interface NodeCatalogEntry {
  kind: NodeKind;
  label: string;
  group: "content" | "generation" | "transformation";
  provider?: ProviderId;
  description?: string;
  icon?: string;
  defaultGenMode?: GenMode;
}

export const NODE_CATALOG: NodeCatalogEntry[] = [
  // Content
  // Note: `content.image`, `content.video`, `content.audio` kinds are kept in
  // the NodeKind union for back-compat with older saved workflows, but they're
  // intentionally omitted from the catalog (and thus the quick-add menu /
  // palette) — they had no inspector and no way to input data. Use `Upload`
  // instead for local files, or generation nodes for AI output.
  { kind: "content.text", label: "Text", group: "content", icon: "type", description: "Prompt text" },
  { kind: "content.upload", label: "Upload", group: "content", icon: "upload", description: "Upload file từ máy" },

  // Generation
  {
    kind: "gen.image",
    label: "Image Generation",
    group: "generation",
    provider: "veo",
    icon: "wand",
    description: "Tạo ảnh (VEO Nano Banana / Imagen)",
    defaultGenMode: "t2i.veo",
  },
  {
    kind: "gen.video",
    label: "Video Generation",
    group: "generation",
    icon: "film",
    description: "Tạo video (VEO / Grok, T2V / I2V)",
    defaultGenMode: "t2v.veo",
  },
  {
    kind: "gen.start-end",
    label: "Start + End → Video",
    group: "generation",
    provider: "veo",
    icon: "arrows",
    description: "VEO frame-first-last",
  },

  // Transformation
  {
    kind: "xform.upscale.grok",
    label: "Upscale HD (Grok)",
    group: "transformation",
    provider: "grok",
    icon: "chevrons-up",
    description: "Upscale lên HD",
  },
  {
    kind: "xform.enhance",
    label: "Enhance",
    group: "transformation",
    icon: "sparkles",
    description: "Tăng chất lượng (local)",
  },
  {
    kind: "xform.remove-bg",
    label: "Remove BG",
    group: "transformation",
    icon: "eraser",
    description: "Tách nền (local)",
  },
  {
    kind: "xform.extract-frames",
    label: "Extract Frames",
    group: "transformation",
    provider: "local",
    icon: "frame",
    description: "Tách frame từ video",
  },
];

export interface OutputItem {
  imageUrl?: string;
  imageMediaId?: string;
  videoUrl?: string;
  videoHdUrl?: string;
  mimeType?: string;
  label?: string;
}

export interface NodeDataBase extends Record<string, unknown> {
  kind: NodeKind;
  label?: string;
  status?: "idle" | "queued" | "running" | "done" | "error";
  /** Last log line from the server (shown on the node while running/queued). */
  statusLog?: string;
  progress?: number;
  error?: string;
  // Primary output (legacy / first item convenience)
  imageUrl?: string;
  imageMediaId?: string;
  videoUrl?: string;
  videoHdUrl?: string;
  text?: string;
  /** Text concatenated from upstream text nodes (read-only for UI). executor/runtime reads `effectiveText || text`. */
  effectiveText?: string;
  audioUrl?: string;
  // Full list of generated outputs (count can be > 1)
  outputs?: OutputItem[];
  // Config
  prompt?: string;
  aspectRatio?: string;
  resolution?: "480p" | "720p";
  videoLength?: number;
  outputCount?: number;
  modelLabel?: string;
  /** Raw model key override (bypass label→key mapping). */
  videoModelKey?: string;
  seed?: number;
  /** Sub-type for generic gen nodes (gen.image / gen.video). */
  genMode?: GenMode;
  /**
   * Overflow outputs (items[1..]) when the server returns more than one result even though
   * count=1 was requested. The client reads this field to spawn clone nodes holding those
   * results, then deletes the field before saving to the original node.
   */
  outputsOverflow?: OutputItem[];
  // Input refs (upstream file path or base64)
  uploadFilePath?: string;
  uploadBase64?: string;
  uploadMime?: string;
  /**
   * Hint for `<input type="file" accept>` when the node is created from the LeftToolbar flyout
   * (e.g. "image/*" when clicking "Upload Image", "video/*" when clicking "Upload Video").
   * Kept separate from `uploadMime` (mime of the chosen file) so Replace isn't
   * locked back to a specific mime.
   */
  uploadAccept?: string;
}
