import { describe, it, expect } from "vitest";

import {
  sanitizeWorkflowId,
  workflowAssetPath,
  workflowAssetsDir,
} from "@/server/paths/workflowAssets";

/**
 * Every `wsu://workflow/<id>/assets/<...>` request the MCP resource handler
 * receives routes through `sanitizeWorkflowId` + `workflowAssetPath`. These
 * tests pin down the sandbox guarantees the handler relies on.
 */
describe("mcp resource sandbox", () => {
  const id = "wf_testid";

  it("accepts a valid workflow id", () => {
    expect(sanitizeWorkflowId(id)).toBe(id);
  });

  it("rejects ids with path separators or parent-dir tricks", () => {
    expect(sanitizeWorkflowId("../etc")).toBe(null);
    expect(sanitizeWorkflowId("wf/../other")).toBe(null);
    expect(sanitizeWorkflowId("wf\\win")).toBe(null);
    expect(sanitizeWorkflowId("")).toBe(null);
    expect(sanitizeWorkflowId(null)).toBe(null);
  });

  it("rejects ids containing characters outside [A-Za-z0-9._-]", () => {
    expect(sanitizeWorkflowId("wf spaces")).toBe(null);
    expect(sanitizeWorkflowId("wf$")).toBe(null);
    expect(sanitizeWorkflowId("wf%20enc")).toBe(null);
  });

  it("workflowAssetPath stays inside the assets root", () => {
    const root = workflowAssetsDir(id);
    const inside = workflowAssetPath(id, "outputs", "a.png");
    expect(inside).toBeTruthy();
    expect(inside!.startsWith(root)).toBe(true);
  });

  it("workflowAssetPath rejects path traversal", () => {
    expect(workflowAssetPath(id, "..", "etc")).toBe(null);
    expect(workflowAssetPath(id, "outputs", "..", "..", "escape.txt")).toBe(null);
    expect(workflowAssetPath(id, "..\\..\\etc")).toBe(null);
  });

  it("workflowAssetPath accepts nested subpaths", () => {
    const inside = workflowAssetPath(id, "outputs", "sub", "nested", "file.mp4");
    expect(inside).toBeTruthy();
    const root = workflowAssetsDir(id);
    expect(inside!.startsWith(root)).toBe(true);
  });
});
