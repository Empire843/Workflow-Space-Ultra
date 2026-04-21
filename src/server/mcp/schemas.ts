import { z } from "zod";

/**
 * Zod schemas for every MCP tool input. Kept in one place so the SDK (which
 * expects a ZodRawShape, i.e. the `.shape` of a plain object) can ingest them
 * with `.pick()` or direct spread, and tests can import the constants without
 * pulling in the rest of the MCP surface.
 *
 * Design notes:
 *  - All image inputs arrive as URLs (local `/api/workflows/...`, `http(s)`,
 *    or `data:` URIs). Base64 transfer over MCP bloats the protocol and the
 *    host already has filesystem access to whatever URI we hand back.
 *  - `workflowId` is optional everywhere. When absent, outputs land in the
 *    flat `downloads/` dir (same fallback the legacy queue already uses).
 *  - We stay permissive on `modelLabel` / `videoModelKey` (free-form strings)
 *    so new VEO / Grok models don't need a schema bump — the provider layer
 *    is the source of truth and surfaces a clean error when the key is
 *    unknown.
 */

const AspectRatio = z.enum(["16:9", "9:16", "1:1"]).describe("Aspect ratio of the output");
const Resolution = z.enum(["480p", "720p"]).describe("Output resolution (Grok only)");

export const ImageInputShape = {
  prompt: z.string().min(1).describe("Text prompt describing the image to generate"),
  modelLabel: z
    .string()
    .optional()
    .describe("VEO image model label (e.g. 'Nano Banana 2', 'Imagen 4')"),
  aspectRatio: AspectRatio.optional(),
  outputCount: z.number().int().min(1).max(8).optional().describe("How many images to return (default 1)"),
  seed: z.number().int().optional(),
  workflowId: z.string().optional().describe("If set, outputs land in Workflows/<id>/assets/outputs"),
  referenceImageUrls: z
    .array(z.string().min(1))
    .optional()
    .describe("Upstream reference images (only Nano Banana* models accept these)"),
};

export const VideoT2VShape = {
  prompt: z.string().min(1),
  provider: z.enum(["veo", "grok"]).describe("Which provider to run on"),
  aspectRatio: AspectRatio.optional(),
  resolution: Resolution.optional().describe("Grok only — 480p or 720p"),
  videoLength: z.number().int().min(1).max(10).optional().describe("Grok only — seconds, 1-10"),
  outputCount: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().optional(),
  modelLabel: z.string().optional().describe("VEO only — model label, e.g. 'VEO 3.1 Ultra'"),
  videoModelKey: z.string().optional().describe("VEO only — raw model key override"),
  workflowId: z.string().optional(),
};

export const VideoI2VShape = {
  ...VideoT2VShape,
  startImageUrl: z.string().min(1).describe("URL of the start (or only) image frame"),
};

export const VideoStartEndShape = {
  prompt: z.string().min(1),
  startImageUrl: z.string().min(1),
  endImageUrl: z.string().min(1),
  aspectRatio: AspectRatio.optional(),
  outputCount: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().optional(),
  modelLabel: z.string().optional(),
  videoModelKey: z.string().optional(),
  workflowId: z.string().optional(),
};

export const JobIdShape = {
  jobId: z.string().min(1),
};

export const OpenLoginShape = {
  target: z.enum(["veo", "grok"]),
  profileName: z.string().optional().describe("Grok only — which profile to open (default PROFILE_1)"),
};

export const WorkflowIdShape = {
  workflowId: z.string().min(1),
};

export const BuildWorkflowShape = {
  name: z.string().min(1).describe("Workflow name"),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).describe("Unique node id (e.g. 'text_1', 'img_1', 'vid_1')"),
        kind: z
          .string()
          .min(1)
          .describe(
            "Node kind: 'content.text', 'content.upload', 'gen.image', 'gen.video', 'gen.start-end', 'xform.upscale.grok', 'frame'",
          ),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Node data fields: prompt, text, aspectRatio, genMode ('t2v.veo'|'t2v.grok'|'t2i.veo'), modelLabel, outputCount, etc.",
          ),
      }),
    )
    .min(1)
    .describe("Array of nodes to place on the canvas"),
  edges: z
    .array(
      z.object({
        source: z.string().min(1).describe("Source node id"),
        target: z.string().min(1).describe("Target node id"),
      }),
    )
    .optional()
    .describe("Edges connecting nodes (source → target)"),
};

export type ImageInput = z.infer<z.ZodObject<typeof ImageInputShape>>;
export type VideoT2VInput = z.infer<z.ZodObject<typeof VideoT2VShape>>;
export type VideoI2VInput = z.infer<z.ZodObject<typeof VideoI2VShape>>;
export type VideoStartEndInput = z.infer<z.ZodObject<typeof VideoStartEndShape>>;
export type BuildWorkflowInput = z.infer<ReturnType<typeof z.object<typeof BuildWorkflowShape>>>;
