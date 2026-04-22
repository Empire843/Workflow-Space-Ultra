import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { WORKFLOWS_DIR } from "@/server/config";
import {
  sanitizeWorkflowId,
  workflowAssetPath,
  workflowAssetsDir,
  workflowDir,
} from "@/server/paths/workflowAssets";

/**
 * Expose on-disk workflow assets as MCP resources.
 *
 * URIs emitted:
 *   wsu://workflow/<id>/snapshot                 → JSON graph (if present)
 *   wsu://workflow/<id>/assets/<subpath>         → image/video/audio bytes
 *
 * `registerResource` takes a URI template that the MCP client uses to
 * enumerate + read. We also implement the `list` callback so Claude /
 * Cursor can browse everything the server can serve without guessing paths.
 */

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  json: "application/json",
  txt: "text/plain",
};

function mimeFromExt(p: string): string {
  const ext = path.extname(p).toLowerCase().replace(/^\./, "");
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function isText(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

function listWorkflowIds(): string[] {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  try {
    return readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((id) => sanitizeWorkflowId(id) === id);
  } catch {
    return [];
  }
}

/** Recursively walk a directory and return every file's absolute path. */
function walkFiles(root: string, rel = ""): Array<{ rel: string; abs: string }> {
  const absDir = path.join(root, rel);
  if (!existsSync(absDir)) return [];
  const out: Array<{ rel: string; abs: string }> = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
    const absEntry = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, nextRel));
    } else if (entry.isFile()) {
      out.push({ rel: nextRel, abs: absEntry });
    }
  }
  return out;
}

/**
 * Strip a reserved-ish leading slash from a URI template variable. `{+path}`
 * matches arbitrary slash-containing segments but MCP host libraries
 * occasionally deliver it with a leading `/`; we normalize here.
 */
function trimLeading(p: string): string {
  return p.replace(/^\/+/, "");
}

export function registerResources(server: McpServer): void {
  // ── workflow snapshots (JSON graph written by the client) ────────────────
  server.registerResource(
    "workflow_snapshot",
    new ResourceTemplate("wsu://workflow/{id}/snapshot", {
      list: async () => ({
        resources: listWorkflowIds()
          .map((id) => {
            const snap = path.join(workflowDir(id), "snapshot.json");
            if (!existsSync(snap)) return null;
            return {
              uri: `wsu://workflow/${id}/snapshot`,
              name: `Workflow ${id} graph`,
              mimeType: "application/json",
            };
          })
          .filter((r): r is { uri: string; name: string; mimeType: string } => r !== null),
      }),
    }),
    {
      title: "Workflow snapshot",
      description:
        "JSON graph (nodes + edges) of a saved workflow, synced from the browser IndexedDB. Available only for workflows the user has opened at least once.",
    },
    async (_uri, { id }) => {
      const workflowId = sanitizeWorkflowId(String(id));
      if (!workflowId) throw new Error(`Invalid workflow id: ${id}`);
      const snapPath = path.join(workflowDir(workflowId), "snapshot.json");
      if (!existsSync(snapPath)) {
        throw new Error(
          `No snapshot for workflow ${workflowId}. Open it in the browser UI once so the client writes snapshot.json.`,
        );
      }
      const text = readFileSync(snapPath, "utf-8");
      return {
        contents: [
          {
            uri: `wsu://workflow/${workflowId}/snapshot`,
            mimeType: "application/json",
            text,
          },
        ],
      };
    },
  );

  // ── workflow asset files (images / videos / uploads) ────────────────────
  server.registerResource(
    "workflow_asset",
    new ResourceTemplate("wsu://workflow/{id}/assets/{+path}", {
      list: async () => {
        const resources: Array<{ uri: string; name: string; mimeType: string }> = [];
        for (const id of listWorkflowIds()) {
          const root = workflowAssetsDir(id);
          for (const { rel } of walkFiles(root)) {
            const encoded = rel
              .split("/")
              .map((s) => encodeURIComponent(s))
              .join("/");
            resources.push({
              uri: `wsu://workflow/${id}/assets/${encoded}`,
              name: `${id}/${rel}`,
              mimeType: mimeFromExt(rel),
            });
          }
        }
        return { resources };
      },
    }),
    {
      title: "Workflow asset",
      description:
        "Binary media (images, videos) plus user uploads living under Workflows/<id>/assets. Paths are sandboxed to that directory — any attempt to escape is rejected.",
    },
    async (uri, variables) => {
      const workflowId = sanitizeWorkflowId(String(variables.id));
      if (!workflowId) throw new Error(`Invalid workflow id: ${variables.id}`);
      const raw = Array.isArray(variables.path) ? variables.path.join("/") : String(variables.path);
      const segments = trimLeading(raw)
        .split("/")
        .filter(Boolean)
        .map((s) => decodeURIComponent(s));
      const abs = workflowAssetPath(workflowId, ...segments);
      if (!abs || !existsSync(abs)) throw new Error(`Asset not found: ${uri.toString()}`);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`Not a file: ${uri.toString()}`);
      const mime = mimeFromExt(abs);
      const buf = readFileSync(abs);
      if (isText(mime)) {
        return {
          contents: [{ uri: uri.toString(), mimeType: mime, text: buf.toString("utf-8") }],
        };
      }
      return {
        contents: [{ uri: uri.toString(), mimeType: mime, blob: buf.toString("base64") }],
      };
    },
  );
}
