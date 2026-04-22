import { describe, it, expect, beforeEach } from "vitest";

import { getMcpToken, isAuthorized } from "@/server/mcp/auth";

/**
 * The HTTP MCP route gates every request with `isAuthorized`. We validate
 * the bearer-token parsing + constant-time compare here so any regression
 * (e.g. accidentally returning `true` on empty header) surfaces fast.
 */
describe("mcp http auth", () => {
  beforeEach(() => {
    // Force the env-token path so the test never touches the on-disk fallback
    // (which would be created in `data_general/` and leak across runs).
    process.env.MCP_TOKEN = "test-token-1234567890";
  });

  it("returns the env token", () => {
    expect(getMcpToken()).toBe("test-token-1234567890");
  });

  it("rejects missing header", () => {
    expect(isAuthorized(null)).toBe(false);
    expect(isAuthorized(undefined)).toBe(false);
    expect(isAuthorized("")).toBe(false);
  });

  it("rejects non-Bearer schemes", () => {
    expect(isAuthorized("Basic dGVzdDp0ZXN0")).toBe(false);
    expect(isAuthorized("token test-token-1234567890")).toBe(false);
  });

  it("rejects wrong token", () => {
    expect(isAuthorized("Bearer nope")).toBe(false);
    expect(isAuthorized("Bearer test-token-1234567891")).toBe(false);
    // Length mismatch (shorter) must also fail cleanly — the constant-time
    // compare would throw if we forgot the length guard.
    expect(isAuthorized("Bearer short")).toBe(false);
  });

  it("accepts the exact token, case-insensitive scheme", () => {
    expect(isAuthorized("Bearer test-token-1234567890")).toBe(true);
    expect(isAuthorized("bearer test-token-1234567890")).toBe(true);
    expect(isAuthorized("BEARER test-token-1234567890")).toBe(true);
  });

  it("tolerates extra whitespace", () => {
    expect(isAuthorized("  Bearer test-token-1234567890  ")).toBe(true);
  });
});
