import { NextResponse } from "next/server";

import { PUBLIC_BASE_URL, oauthPublicUrls } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hand-written OpenAPI 3.1 schema describing every /api/actions/* endpoint.
 *
 * ChatGPT's "Create Action" UI ingests this JSON directly: it maps the
 * `paths` entries into tool stubs it can call, and it reads
 * `components.securitySchemes.oauth2` to drive the OAuth configuration step.
 *
 * The schema is kept in sync with the zod shapes in `src/server/mcp/schemas.ts`
 * by convention — if you add a field there, mirror it here.
 */

const AspectRatioEnum = ["16:9", "9:16", "1:1"];
const ResolutionEnum = ["480p", "720p"];
const ProviderEnum = ["veo", "grok"];

function imageInputSchema() {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", description: "Text prompt describing the image to generate" },
      modelLabel: {
        type: "string",
        description: "VEO image model label (e.g. 'Nano Banana 2', 'Imagen 4')",
      },
      aspectRatio: { type: "string", enum: AspectRatioEnum },
      outputCount: { type: "integer", minimum: 1, maximum: 8 },
      seed: { type: "integer" },
      workflowId: {
        type: "string",
        description: "Existing workflow to append output into; omit to auto-create",
      },
      referenceImageUrls: {
        type: "array",
        items: { type: "string" },
        description: "Optional reference images (Nano Banana family only)",
      },
    },
  } as const;
}

function videoT2VSchema() {
  return {
    type: "object",
    required: ["prompt", "provider"],
    properties: {
      prompt: { type: "string" },
      provider: { type: "string", enum: ProviderEnum },
      aspectRatio: { type: "string", enum: AspectRatioEnum },
      resolution: { type: "string", enum: ResolutionEnum, description: "Grok only" },
      videoLength: {
        type: "integer",
        minimum: 1,
        maximum: 10,
        description: "Grok only — seconds",
      },
      outputCount: { type: "integer", minimum: 1, maximum: 4 },
      seed: { type: "integer" },
      modelLabel: { type: "string", description: "VEO only — e.g. 'VEO 3.1 Ultra'" },
      videoModelKey: { type: "string", description: "VEO only — raw model key override" },
      workflowId: { type: "string" },
    },
  } as const;
}

function videoI2VSchema() {
  const base = videoT2VSchema();
  return {
    ...base,
    required: [...base.required, "startImageUrl"],
    properties: {
      ...base.properties,
      startImageUrl: { type: "string", description: "URL of the start (or only) image frame" },
    },
  } as const;
}

function videoStartEndSchema() {
  return {
    type: "object",
    required: ["prompt", "startImageUrl", "endImageUrl"],
    properties: {
      prompt: { type: "string" },
      startImageUrl: { type: "string" },
      endImageUrl: { type: "string" },
      aspectRatio: { type: "string", enum: AspectRatioEnum },
      outputCount: { type: "integer", minimum: 1, maximum: 4 },
      seed: { type: "integer" },
      modelLabel: { type: "string" },
      videoModelKey: { type: "string" },
      workflowId: { type: "string" },
    },
  } as const;
}

function buildWorkflowSchema() {
  return {
    type: "object",
    required: ["name", "nodes"],
    properties: {
      name: { type: "string" },
      nodes: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["id", "kind"],
          properties: {
            id: { type: "string" },
            kind: {
              type: "string",
              description:
                "content.text | content.upload | gen.image | gen.video | gen.start-end | xform.upscale.grok | frame",
            },
            data: { type: "object", additionalProperties: true },
          },
        },
      },
      edges: {
        type: "array",
        items: {
          type: "object",
          required: ["source", "target"],
          properties: {
            source: { type: "string" },
            target: { type: "string" },
          },
        },
      },
    },
  } as const;
}

function buildSpec(baseUrl: string) {
  const urls = oauthPublicUrls();
  const security = [{ oauth2: ["wsu:all"] }];

  return {
    openapi: "3.1.0",
    info: {
      title: "Workflow Space Ultra — GPT Actions",
      version: "0.1.0",
      description:
        "Trigger VEO / Grok image & video generation and build node-graph workflows in WSU from a ChatGPT Custom GPT.",
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: urls.authorizationUrl,
              tokenUrl: urls.tokenUrl,
              scopes: { "wsu:all": "Full access to WSU actions" },
            },
          },
        },
      },
    },
    security,
    paths: {
      "/api/actions/gen/image": {
        post: {
          operationId: "genImage",
          summary: "Generate image(s) via VEO",
          security,
          requestBody: {
            required: true,
            content: { "application/json": { schema: imageInputSchema() } },
          },
          responses: {
            "200": {
              description: "Job finished",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      jobId: { type: "string" },
                      workflowId: { type: "string" },
                      imageUrls: { type: "array", items: { type: "string" } },
                      outputs: { type: "array", items: { type: "object", additionalProperties: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/actions/gen/video/t2v": {
        post: {
          operationId: "genVideoT2V",
          summary: "Generate video from text (VEO or Grok)",
          security,
          requestBody: {
            required: true,
            content: { "application/json": { schema: videoT2VSchema() } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/gen/video/i2v": {
        post: {
          operationId: "genVideoI2V",
          summary: "Generate video from image (I2V)",
          security,
          requestBody: {
            required: true,
            content: { "application/json": { schema: videoI2VSchema() } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/gen/video/start-end": {
        post: {
          operationId: "genVideoStartEnd",
          summary: "Generate video from a start + end frame pair (VEO)",
          security,
          requestBody: {
            required: true,
            content: { "application/json": { schema: videoStartEndSchema() } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/workflows/build": {
        post: {
          operationId: "buildWorkflow",
          summary: "Create a new workflow graph (scenes / nodes / edges)",
          description:
            "Ideal for 'clone a video as a workflow': supply one text node per scene, connect to gen.image → gen.video, and the canvas will render it left-to-right.",
          security,
          requestBody: {
            required: true,
            content: { "application/json": { schema: buildWorkflowSchema() } },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/workflows": {
        get: {
          operationId: "listWorkflows",
          summary: "List workflows on disk",
          security,
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/workflows/{id}": {
        get: {
          operationId: "getWorkflow",
          summary: "Get a workflow snapshot (nodes + edges)",
          security,
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "OK" },
            "404": { description: "No snapshot yet — open the workflow once in the browser" },
          },
        },
      },
      "/api/actions/jobs": {
        get: {
          operationId: "listJobs",
          summary: "List queued / running / recent jobs",
          security,
          responses: { "200": { description: "OK" } },
        },
      },
      "/api/actions/jobs/{id}": {
        get: {
          operationId: "getJob",
          summary: "Poll a single job",
          security,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
        },
        delete: {
          operationId: "cancelJob",
          summary: "Cancel a job (id='*' cancels all active)",
          security,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK" }, "404": { description: "Not found" } },
        },
      },
      "/api/actions/auth/status": {
        get: {
          operationId: "authStatus",
          summary: "Check VEO / Grok login status",
          security,
          responses: { "200": { description: "OK" } },
        },
      },
    },
  } as const;
}

export async function GET(): Promise<Response> {
  const spec = buildSpec(PUBLIC_BASE_URL);
  return NextResponse.json(spec, {
    headers: {
      // ChatGPT re-fetches the spec every few minutes; keep it fresh but CDN-friendly.
      "cache-control": "public, max-age=60, must-revalidate",
      "access-control-allow-origin": "*",
    },
  });
}
