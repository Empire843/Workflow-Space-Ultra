import { z } from "zod";

/**
 * Zod schemas for REST/SSE boundaries. Runtime validation replaces hand-rolled
 * `if (!body.foo)` checks in route handlers and provides structured errors for
 * clients. Inferred types are used by server code; client code continues to
 * use the richer TS types from `@/lib/nodes`.
 */

export const NodeKindSchema = z.enum([
  "content.image",
  "content.video",
  "content.text",
  "content.audio",
  "content.upload",
  "gen.image",
  "gen.video",
  "gen.start-end",
  "xform.upscale.grok",
  "xform.enhance",
  "xform.remove-bg",
  "xform.extract-frames",
]);

export const GenModeSchema = z.enum([
  "t2v.veo",
  "t2v.grok",
  "i2v.veo",
  "i2v.grok",
  "t2i.veo",
  "t2i.grok",
  "se2v.veo",
]);

/** Loose schema for node data — any key/value. We pass the whole payload through
 *  to the executor so fields-added-tomorrow keep working without a schema bump. */
export const NodeDataSchema = z.object({}).passthrough();

export const EnqueueJobSchema = z.object({
  nodeId: z.string().min(1),
  kind: NodeKindSchema,
  data: NodeDataSchema,
  inputs: z.array(NodeDataSchema).optional(),
  workflowRunId: z.string().optional(),
});

export type EnqueueJobInput = z.infer<typeof EnqueueJobSchema>;

// SSE job events. Kept permissive on payload, strict on type tag.
export const JobEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    job: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal("progress"),
    progress: z.number().min(0).max(100),
    statusLog: z.string().optional(),
  }),
  z.object({
    type: z.literal("output"),
    output: z.object({}).passthrough(),
  }),
  z.object({
    type: z.literal("status"),
    status: z.enum(["queued", "running", "done", "error", "cancelled"]),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
  }),
  z.object({ type: z.literal("ping") }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;

// --- /api/config ---------------------------------------------------------

export const ClientSettingsSchema = z.object({
  accountType: z.enum(["NORMAL", "PRO", "ULTRA"]),
  veoProjectId: z.string(),
  veoSessionId: z.string(),
  createImageModel: z.string().min(1),
  seedMode: z.enum(["Random", "Fixed"]),
  seedValue: z.number().int(),
  veoConcurrency: z.number().int().min(1).max(8),
  grokConcurrency: z.number().int().min(1).max(8),
});

export const SaveConfigSchema = z.object({
  settings: ClientSettingsSchema,
});

export type ClientSettings = z.infer<typeof ClientSettingsSchema>;
