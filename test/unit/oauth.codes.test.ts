import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __clearAuthCodes,
  consumeAuthCode,
  issueAuthCode,
} from "@/server/oauth/codes";

/**
 * Cover the hot paths of `src/server/oauth/codes.ts`:
 *   - TTL expiry (60s)
 *   - single-use (even on failure, so no oracle)
 *   - binding to clientId + redirectUri
 *   - PKCE S256 happy path + failure
 */

describe("oauth authorization codes", () => {
  beforeEach(() => {
    __clearAuthCodes();
  });

  afterEach(() => {
    vi.useRealTimers();
    __clearAuthCodes();
  });

  it("issues a code bound to client + redirect", () => {
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://chat.openai.com/aip/g-x/oauth/callback",
      scopes: ["wsu:all"],
    });
    const ok = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://chat.openai.com/aip/g-x/oauth/callback",
    });
    expect(ok.ok).toBe(true);
    expect(ok.record?.scopes).toEqual(["wsu:all"]);
  });

  it("is single-use", () => {
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
    });
    expect(
      consumeAuthCode({ code, clientId: "client_abc", redirectUri: "https://x/cb" }).ok,
    ).toBe(true);
    const second = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
    });
    expect(second.ok).toBe(false);
  });

  it("rejects wrong client_id and marks the code used", () => {
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
    });
    const wrong = consumeAuthCode({
      code,
      clientId: "client_other",
      redirectUri: "https://x/cb",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toBe("client_mismatch");
    // Even the correct client can't use it now.
    const retry = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
    });
    expect(retry.ok).toBe(false);
  });

  it("rejects mismatched redirect_uri", () => {
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://good/cb",
      scopes: ["wsu:all"],
    });
    const r = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://evil/cb",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("redirect_mismatch");
  });

  it("expires after 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
    });
    vi.setSystemTime(new Date(Date.now() + 60_001));
    const r = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("expired");
  });

  it("PKCE S256 happy path", () => {
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier, "utf-8").digest("base64url");
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const ok = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      codeVerifier: verifier,
    });
    expect(ok.ok).toBe(true);
  });

  it("PKCE S256 rejects wrong verifier", () => {
    const verifier = "a".repeat(64);
    const challenge = createHash("sha256").update(verifier, "utf-8").digest("base64url");
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    const bad = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      codeVerifier: "different-verifier",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("pkce_failed");
  });

  it("PKCE requires verifier when challenge is set", () => {
    const code = issueAuthCode({
      clientId: "client_abc",
      redirectUri: "https://x/cb",
      scopes: ["wsu:all"],
      codeChallenge: "challenge-value",
      codeChallengeMethod: "S256",
    });
    const r = consumeAuthCode({
      code,
      clientId: "client_abc",
      redirectUri: "https://x/cb",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("pkce_required");
  });
});
