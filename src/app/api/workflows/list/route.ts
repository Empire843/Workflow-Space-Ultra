import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { WORKFLOWS_DIR } from "@/server/config";
import { sanitizeWorkflowId, workflowDir } from "@/server/paths/workflowAssets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/workflows/list
 *
 * Returns every workflow that has a snapshot.json on disk. This is used by the
 * dashboard to discover MCP-created workflows that were written directly to
 * the filesystem (bypassing IndexedDB).
 */
export async function GET() {
  if (!existsSync(WORKFLOWS_DIR)) {
    return Response.json({ ok: true, workflows: [] });
  }

  const entries = readdirSync(WORKFLOWS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && sanitizeWorkflowId(d.name) === d.name)
    .map((d) => {
      const id = d.name;
      const snapPath = path.join(workflowDir(id), "snapshot.json");
      if (!existsSync(snapPath)) return null;

      try {
        const raw = readFileSync(snapPath, "utf-8");
        const snap = JSON.parse(raw) as {
          name?: string;
          nodes?: unknown[];
          edges?: unknown[];
          updatedAt?: number;
          fromMcp?: boolean;
        };
        // Only return MCP-originated workflows (those created by the MCP server
        // that the client hasn't synced yet).
        if (!snap.fromMcp) return null;

        return {
          id,
          name: snap.name ?? "Untitled",
          nodes: snap.nodes ?? [],
          edges: snap.edges ?? [],
          updatedAt: snap.updatedAt ?? statSync(snapPath).mtimeMs,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return Response.json({ ok: true, workflows: entries });
}
