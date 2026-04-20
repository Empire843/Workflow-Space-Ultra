import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMcpSnapshotDelta } from "@/state/workflowStore";

/**
 * `fetchMcpSnapshotDelta` is the pure-network half of the MCP → canvas merge
 * flow (the other half is the `addNodes` / `_saveCurrentWorkflow` call site
 * inside `loadWorkflow`, which depends on IndexedDB and is exercised in the
 * browser). Here we pin down:
 *   - the HTTP call goes to the right URL,
 *   - only `data.origin === "mcp"` nodes are returned,
 *   - nodes already present in `existingIds` are filtered out (dedupe),
 *   - 404 / malformed / network failure all produce an empty delta instead
 *     of blowing up `loadWorkflow`.
 */

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    return impl(url);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchMcpSnapshotDelta", () => {
  it("returns MCP-origin nodes not already on the canvas", async () => {
    const spy = mockFetch(() =>
      jsonResponse({
        ok: true,
        workflowId: "wf_x",
        snapshot: {
          nodes: [
            {
              id: "node_ui_1",
              type: "wsNode",
              position: { x: 0, y: 0 },
              data: { kind: "gen.image" },
            },
            {
              id: "mcp_job_a",
              type: "wsNode",
              position: { x: 100, y: 100 },
              data: { kind: "gen.image", origin: "mcp" },
            },
            {
              id: "mcp_job_b",
              type: "wsNode",
              position: { x: 200, y: 100 },
              data: { kind: "gen.video", origin: "mcp" },
            },
          ],
          edges: [],
        },
      }),
    );

    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());

    expect(spy).toHaveBeenCalledTimes(1);
    const calledUrl = String(spy.mock.calls[0][0]);
    expect(calledUrl).toContain("/api/workflows/wf_x/snapshot");
    expect(delta.map((n) => n.id)).toEqual(["mcp_job_a", "mcp_job_b"]);
  });

  it("filters out nodes that are already in IndexedDB (dedupe on reload)", async () => {
    mockFetch(() =>
      jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            {
              id: "mcp_job_a",
              type: "wsNode",
              position: { x: 0, y: 0 },
              data: { kind: "gen.image", origin: "mcp" },
            },
            {
              id: "mcp_job_b",
              type: "wsNode",
              position: { x: 0, y: 0 },
              data: { kind: "gen.image", origin: "mcp" },
            },
          ],
          edges: [],
        },
      }),
    );

    const delta = await fetchMcpSnapshotDelta(
      "wf_x",
      new Set(["mcp_job_a"]),
    );

    expect(delta.map((n) => n.id)).toEqual(["mcp_job_b"]);
  });

  it("ignores nodes without `origin: mcp` (client-authored nodes)", async () => {
    mockFetch(() =>
      jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            {
              id: "node_ui_1",
              type: "wsNode",
              position: { x: 0, y: 0 },
              data: { kind: "gen.image" },
            },
            {
              id: "node_ui_2",
              type: "wsNode",
              position: { x: 0, y: 0 },
              data: { kind: "gen.video", origin: "ui" },
            },
          ],
          edges: [],
        },
      }),
    );

    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());
    expect(delta).toHaveLength(0);
  });

  it("treats a 404 (no snapshot yet) as an empty delta", async () => {
    mockFetch(() =>
      jsonResponse({ ok: false, message: "No snapshot yet" }, 404),
    );
    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());
    expect(delta).toEqual([]);
  });

  it("returns [] on malformed snapshot payload", async () => {
    mockFetch(() => jsonResponse({ ok: true, snapshot: "not-an-object" }));
    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());
    expect(delta).toEqual([]);
  });

  it("returns [] on network / fetch failure", async () => {
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());
    expect(delta).toEqual([]);
  });

  it("normalises missing position / type so React Flow can render the node", async () => {
    mockFetch(() =>
      jsonResponse({
        ok: true,
        snapshot: {
          nodes: [
            {
              id: "mcp_job_a",
              // No `type`, no `position` — server-written nodes must still
              // arrive on the canvas with a usable default.
              data: { kind: "gen.image", origin: "mcp" },
            },
          ],
          edges: [],
        },
      }),
    );

    const delta = await fetchMcpSnapshotDelta("wf_x", new Set<string>());
    expect(delta).toHaveLength(1);
    expect(delta[0].type).toBe("wsNode");
    expect(delta[0].position).toEqual({ x: 0, y: 0 });
  });
});
