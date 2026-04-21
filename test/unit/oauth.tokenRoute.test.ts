import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/oauth/token/route";
import { registerClient } from "@/server/oauth/clients";
import { __clearAuthCodes, issueAuthCode } from "@/server/oauth/codes";
import { __resetTokenStore } from "@/server/oauth/tokens";

/**
 * Integration tests against the `/api/oauth/token` handler. We invoke it
 * directly (no running Next server) with hand-rolled `Request` objects. This
 * covers the happy path for both grants plus the most common failure modes.
 */

function formBody(params: Record<string, string>): Request {
  const body = new URLSearchParams(params).toString();
  return new Request("http://localhost/api/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function withBasicAuth(req: Request, clientId: string, clientSecret: string): Request {
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const headers = new Headers(req.headers);
  headers.set("authorization", `Basic ${creds}`);
  return new Request(req.url, { method: req.method, headers, body: req.body });
}

describe("/api/oauth/token route", () => {
  let tmpDir: string;
  let clientId: string;
  let clientSecret: string;
  const redirectUri = "https://chatgpt.com/aip/g-test/oauth/callback";

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "wsu-oauth-route-"));
    process.env.WSU_OAUTH_DIR = tmpDir;
    __resetTokenStore();
    __clearAuthCodes();
    const plain = registerClient("TestGPT", [redirectUri], ["wsu:all"]);
    clientId = plain.id;
    clientSecret = plain.secret;
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("authorization_code happy path", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "state-1",
    });
    const req = formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(data.token_type).toBe("bearer");
    expect(data.access_token.length).toBeGreaterThan(10);
    expect(data.refresh_token.length).toBeGreaterThan(10);
    expect(data.expires_in).toBeGreaterThan(0);
    expect(data.scope).toBe("wsu:all");
  });

  it("authorization_code via HTTP Basic auth", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "s",
    });
    let req = formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    req = withBasicAuth(req, clientId, clientSecret);
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("rejects bad client_secret", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "s",
    });
    const req = formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: "wrong-secret",
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("invalid_client");
  });

  it("rejects mismatched redirect_uri", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "s",
    });
    const req = formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://evil/cb",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("invalid_grant");
  });

  it("rejects a replayed code", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "s",
    });
    const makeReq = () =>
      formBody({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      });
    expect((await POST(makeReq())).status).toBe(200);
    const second = await POST(makeReq());
    expect(second.status).toBe(400);
  });

  it("refresh_token happy path + rotation", async () => {
    const code = issueAuthCode({
      clientId,
      redirectUri,
      scopes: ["wsu:all"],
      state: "s",
    });
    const first = (await (
      await POST(
        formBody({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      )
    ).json()) as { access_token: string; refresh_token: string };

    const refreshRes = await POST(
      formBody({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    );
    expect(refreshRes.status).toBe(200);
    const second = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    // Old refresh cannot be reused.
    const replay = await POST(
      formBody({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    );
    expect(replay.status).toBe(400);
  });

  it("rejects unsupported grant_type", async () => {
    const req = formBody({
      grant_type: "password",
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("unsupported_grant_type");
  });
});
