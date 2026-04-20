import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { DATA_GENERAL_DIR } from "@/server/config";

/**
 * Bearer-token gate for the HTTP MCP transport.
 *
 * Precedence:
 *  1. `process.env.MCP_TOKEN` — if set, that value is the only accepted token.
 *  2. `data_general/mcp_token.txt` — auto-generated on first run, persisted
 *     across restarts. Safe default so `/api/mcp` is never wide-open on a
 *     machine reachable over the network.
 *
 * Stdio transport skips this entirely — the transport only runs inside a
 * subprocess spawned by the MCP client, so there is no over-the-wire
 * attack surface.
 */

const TOKEN_FILE = path.join(DATA_GENERAL_DIR, "mcp_token.txt");

let _cachedToken: string | null = null;

export function getMcpToken(): string {
  const env = process.env.MCP_TOKEN?.trim();
  if (env) return env;
  if (_cachedToken) return _cachedToken;

  if (!existsSync(DATA_GENERAL_DIR)) mkdirSync(DATA_GENERAL_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf-8").trim();
    if (existing) {
      _cachedToken = existing;
      return existing;
    }
  }
  const fresh = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, fresh, { encoding: "utf-8", mode: 0o600 });
  _cachedToken = fresh;
  // Print once so the user can copy it into the MCP client config.
  // Hidden in production by the INFO level — dev surfaces it in the terminal.
  // eslint-disable-next-line no-console
  console.info(
    `[mcp] generated new HTTP bearer token (saved to ${TOKEN_FILE}). ` +
      `Use this as 'Authorization: Bearer <token>' when connecting remotely.`,
  );
  return fresh;
}

/**
 * Parse `Authorization: Bearer <token>` and constant-time compare against
 * the server's token. Returns true only on exact match.
 */
export function isAuthorized(headerValue: string | null | undefined): boolean {
  if (!headerValue) return false;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].trim(), "utf-8");
  const expected = Buffer.from(getMcpToken(), "utf-8");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}
