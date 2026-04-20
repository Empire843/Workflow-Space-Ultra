import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WORKFLOWS_DIR } from "@/server/config";
import {
  appendMcpNodeToSnapshot,
  buildMcpImageNode,
  buildMcpVideoNode,
  mcpNodeIdForJob,
} from "@/server/mcp/snapshotWriter";

/**
 * These tests exercise real filesystem I/O against `Workflows/<id>/snapshot.json`.
 * Each case uses a disposable workflowId (prefixed with `wf_test_snap_`) so we
 * can blanket-wipe them in `afterEach` without risking user data.
 *
 * The writer is the one place server-side MCP pokes into the client's canvas
 * state — regressions here silently break "generated via MCP appears on the
 * canvas", so we pin down the append + dedupe + concurrency guarantees.
 */

const TEST_PREFIX = "wf_test_snap_";

function mkWorkflowId(suffix: string): string {
  // Timestamp disambiguates parallel test runs (vitest --shard).
  return `${TEST_PREFIX}${suffix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function snapshotPath(id: string): string {
  return path.join(WORKFLOWS_DIR, id, "snapshot.json");
}

function readSnapshot(id: string): {
  nodes: Array<{ id: string; data?: { origin?: string } }>;
  edges: unknown[];
  fromMcp?: boolean;
} {
  const raw = readFileSync(snapshotPath(id), "utf-8");
  return JSON.parse(raw);
}

afterEach(() => {
  if (!existsSync(WORKFLOWS_DIR)) return;
  // Wipe any test workflow dirs we created. Non-test folders are untouched.
  for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(TEST_PREFIX)) {
      rmSync(path.join(WORKFLOWS_DIR, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
});

describe("appendMcpNodeToSnapshot", () => {
  it("creates snapshot.json + writes the first MCP node when no file exists", async () => {
    const wf = mkWorkflowId("create");
    const node = buildMcpImageNode({
      jobId: "job_alpha",
      prompt: "a cat",
      outputs: [{ imageUrl: "https://example.local/a.png" }],
      modelLabel: "Nano Banana",
      aspectRatio: "1:1",
    });

    const written = await appendMcpNodeToSnapshot(wf, node);

    expect(written).toBe(true);
    expect(existsSync(snapshotPath(wf))).toBe(true);
    const snap = readSnapshot(wf);
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0].id).toBe(mcpNodeIdForJob("job_alpha"));
    expect(snap.nodes[0].data?.origin).toBe("mcp");
    expect(snap.fromMcp).toBe(true);
  });

  it("appends subsequent nodes preserving earlier ones", async () => {
    const wf = mkWorkflowId("append");
    await appendMcpNodeToSnapshot(
      wf,
      buildMcpImageNode({
        jobId: "job_a",
        outputs: [{ imageUrl: "https://example.local/a.png" }],
      }),
    );
    await appendMcpNodeToSnapshot(
      wf,
      buildMcpVideoNode({
        jobId: "job_b",
        kind: "gen.video",
        outputs: [{ videoUrl: "https://example.local/b.mp4" }],
      }),
    );

    const snap = readSnapshot(wf);
    expect(snap.nodes.map((n) => n.id)).toEqual([
      mcpNodeIdForJob("job_a"),
      mcpNodeIdForJob("job_b"),
    ]);
  });

  it("dedupes when the same jobId is written twice (retry-safe)", async () => {
    const wf = mkWorkflowId("dedupe");
    const node = buildMcpImageNode({
      jobId: "job_same",
      outputs: [{ imageUrl: "https://example.local/same.png" }],
    });

    const first = await appendMcpNodeToSnapshot(wf, node);
    const second = await appendMcpNodeToSnapshot(wf, node);

    expect(first).toBe(true);
    expect(second).toBe(false);
    const snap = readSnapshot(wf);
    expect(snap.nodes).toHaveLength(1);
  });

  it("serialises concurrent writes — two parallel appends result in two nodes", async () => {
    const wf = mkWorkflowId("concurrent");
    const a = buildMcpImageNode({
      jobId: "job_par_a",
      outputs: [{ imageUrl: "https://example.local/pa.png" }],
    });
    const b = buildMcpImageNode({
      jobId: "job_par_b",
      outputs: [{ imageUrl: "https://example.local/pb.png" }],
    });

    const [aOk, bOk] = await Promise.all([
      appendMcpNodeToSnapshot(wf, a),
      appendMcpNodeToSnapshot(wf, b),
    ]);

    expect(aOk).toBe(true);
    expect(bOk).toBe(true);
    const snap = readSnapshot(wf);
    // Both nodes must land. Without the mutex one write would read the same
    // base file as the other and the second to finish would overwrite the
    // first with only one node.
    expect(snap.nodes).toHaveLength(2);
    const ids = new Set(snap.nodes.map((n) => n.id));
    expect(ids.has(mcpNodeIdForJob("job_par_a"))).toBe(true);
    expect(ids.has(mcpNodeIdForJob("job_par_b"))).toBe(true);
  });

  it("returns false and writes nothing for an invalid workflow id", async () => {
    const ok = await appendMcpNodeToSnapshot(
      "../escape",
      buildMcpImageNode({
        jobId: "job_bad",
        outputs: [{ imageUrl: "https://example.local/x.png" }],
      }),
    );
    expect(ok).toBe(false);
  });
});
