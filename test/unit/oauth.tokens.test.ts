import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTokenStore,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  issueTokenPair,
  revokeAllForClient,
  revokeToken,
  rotateRefreshToken,
  validateAccessToken,
} from "@/server/oauth/tokens";

/**
 * Cover the hot paths of `src/server/oauth/tokens.ts`:
 *   - issue → validate round-trip
 *   - expiry (via Date.now mocking)
 *   - refresh rotation revokes the predecessor pair
 *   - revoke is idempotent + client-scoped revoke works
 *   - timing-safe compare rejects near-misses cleanly (no throw)
 */

describe("oauth tokens", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wsu-oauth-tokens-"));
    process.env.WSU_OAUTH_DIR = tmpDir;
    __resetTokenStore();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    vi.useRealTimers();
  });

  it("issues + validates an access token round-trip", () => {
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    expect(pair.accessToken.length).toBeGreaterThan(10);
    expect(pair.refreshToken.length).toBeGreaterThan(10);
    expect(pair.expiresIn).toBe(Math.floor(ACCESS_TTL_MS / 1000));

    const result = validateAccessToken(pair.accessToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.clientId).toBe("client_abc");
      expect(result.scopes).toEqual(["wsu:all"]);
    }
  });

  it("rejects unknown / empty tokens without throwing", () => {
    expect(validateAccessToken("").ok).toBe(false);
    expect(validateAccessToken(null).ok).toBe(false);
    expect(validateAccessToken("not-a-real-token").ok).toBe(false);
    const res = validateAccessToken("short");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not_found");
  });

  it("rejects refresh tokens when used as bearer", () => {
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    const res = validateAccessToken(pair.refreshToken);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("wrong_type");
  });

  it("expires the access token after its TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    expect(validateAccessToken(pair.accessToken).ok).toBe(true);
    vi.setSystemTime(new Date(Date.now() + ACCESS_TTL_MS + 1));
    const res = validateAccessToken(pair.accessToken);
    expect(res.ok).toBe(false);
  });

  it("rotates on refresh and revokes the old pair", () => {
    const first = issueTokenPair("client_abc", ["wsu:all"]);
    const rotated = rotateRefreshToken(first.refreshToken, "client_abc");
    expect(rotated).not.toBeNull();
    expect(rotated?.accessToken).not.toBe(first.accessToken);
    expect(rotated?.refreshToken).not.toBe(first.refreshToken);
    // Old access token is revoked.
    const oldAccess = validateAccessToken(first.accessToken);
    expect(oldAccess.ok).toBe(false);
    // Old refresh cannot be reused.
    expect(rotateRefreshToken(first.refreshToken, "client_abc")).toBeNull();
    // New access validates.
    expect(validateAccessToken(rotated!.accessToken).ok).toBe(true);
  });

  it("refresh rejects cross-client use", () => {
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    expect(rotateRefreshToken(pair.refreshToken, "client_other")).toBeNull();
  });

  it("refresh expires after REFRESH_TTL_MS", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    vi.setSystemTime(new Date(Date.now() + REFRESH_TTL_MS + 1));
    expect(rotateRefreshToken(pair.refreshToken, "client_abc")).toBeNull();
  });

  it("revokeToken revokes the whole pair", () => {
    const pair = issueTokenPair("client_abc", ["wsu:all"]);
    expect(revokeToken(pair.accessToken)).toBe(true);
    expect(validateAccessToken(pair.accessToken).ok).toBe(false);
    // Refresh from the same pair is also gone.
    expect(rotateRefreshToken(pair.refreshToken, "client_abc")).toBeNull();
    // Revoking again is a no-op but returns false.
    expect(revokeToken(pair.accessToken)).toBe(false);
  });

  it("revokeAllForClient revokes every active pair", () => {
    const a = issueTokenPair("client_abc", ["wsu:all"]);
    const b = issueTokenPair("client_abc", ["wsu:all"]);
    const otherClient = issueTokenPair("client_xyz", ["wsu:all"]);
    const n = revokeAllForClient("client_abc");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(validateAccessToken(a.accessToken).ok).toBe(false);
    expect(validateAccessToken(b.accessToken).ok).toBe(false);
    expect(validateAccessToken(otherClient.accessToken).ok).toBe(true);
  });
});
