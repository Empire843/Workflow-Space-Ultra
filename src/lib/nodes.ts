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
  | "content.clone"
  // Generation (generic — sub-type via `data.genMode`)
  | "gen.image"
  | "gen.video"
  | "gen.start-end"
  // Transformation
  | "xform.upscale.grok"
  | "xform.enhance"
  | "xform.remove-bg"
  | "xform.extract-frames"
  // Group container (visual frame) — holds child nodes via parentId/extent.
  // Rendered by `FrameNode` (not the standard `WSNode`).
  | "frame";

export interface NodeCatalogEntry {
  kind: NodeKind;
  label: string;
  group: "content" | "generation" | "transformation" | "layout";
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
  { kind: "content.clone", label: "Download Video", group: "content", icon: "link", description: "Tải video từ YouTube / link" },

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

  // Layout
  {
    kind: "frame",
    label: "Frame",
    group: "layout",
    icon: "frame",
    description: "Nhóm các node và chạy cùng lúc",
  },
];

/** Pre-computed Map for O(1) lookup — avoids `.find()` on every node render. */
export const NODE_CATALOG_MAP = new Map<NodeKind, NodeCatalogEntry>(
  NODE_CATALOG.map((e) => [e.kind, e] as const),
);

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
  /**
   * Server-assigned job id (set by the client while a job is in flight). Kept
   * on the node so the Queue panel can show "which node runs which job" and so
   * the per-node Cancel button knows which job to DELETE. Cleared when the job
   * settles or the user starts a new run.
   */
  jobId?: string;
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

  // ─── Frame (layout group) ───────────────────────────────────────────────
  // Only meaningful when `kind === "frame"`. Height/width are tracked both in
  // React Flow's `style` and here so persistence round-trips deterministically.
  frameLabel?: string;
  frameWidth?: number;
  frameHeight?: number;
  // Live progress fields populated by `runFrame` while the Frame is running.
  // Stripped from persisted snapshots (see RUNTIME_KEYS in workflowStore).
  frameRunning?: boolean;
  frameRunIndex?: number;
  frameRunTotal?: number;
  frameRunCurrentLabel?: string;

  // ─── MCP provenance ──────────────────────────────────────────────────────
  // Set on nodes synthesised by the MCP server and merged into the canvas
  // from `Workflows/<id>/snapshot.json`. `origin === "mcp"` is the flag the
  // client uses to (a) badge the node visually and (b) offer a "convert to
  // content reference" downgrade. Once the user edits the node, these fields
  // stay but the badge remains so the provenance trail is preserved.
  origin?: "mcp" | "ui";
  mcpJobId?: string;
  mcpCreatedAt?: number;
}
