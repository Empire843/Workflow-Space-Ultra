import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { oauthDir, readJsonFile, writeJsonFile } from "./storage";

/**
 * OAuth client registration — one entry per Custom GPT (or other OAuth client)
 * that the user wants to grant access to WSU.
 *
 * Secrets are stored as sha-256 hashes; the plaintext is only returned from
 * `registerClient` / `rotateSecret` and must be shown to the user exactly
 * once. This is the same pattern `src/server/mcp/auth.ts` uses for the MCP
 * bearer token, adapted to a multi-client store.
 */

export interface OAuthClient {
  id: string;
  name: string;
  secretHash: string;
  redirectUris: string[];
  scopes: string[];
  createdAt: number;
}

export interface PlainClient {
  id: string;
  name: string;
  secret: string;
  redirectUris: string[];
  scopes: string[];
}

function clientsFile(): string {
  return path.join(oauthDir(), "clients.json");
}

interface ClientsDoc {
  version: 1;
  clients: OAuthClient[];
}

const EMPTY: ClientsDoc = { version: 1, clients: [] };

function load(): ClientsDoc {
  const doc = readJsonFile<ClientsDoc>(clientsFile(), EMPTY);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.clients)) return { ...EMPTY };
  return doc;
}

function save(doc: ClientsDoc): void {
  writeJsonFile(clientsFile(), doc);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

function randomId(prefix: string, bytes = 12): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function listClients(): OAuthClient[] {
  return load().clients.slice();
}

export function getClient(id: string): OAuthClient | null {
  return load().clients.find((c) => c.id === id) ?? null;
}

/** Register a new client and return its plaintext secret (shown once). */
export function registerClient(
  name: string,
  redirectUris: string[] = [],
  scopes: string[] = ["wsu:all"],
): PlainClient {
  const doc = load();
  const id = randomId("client");
  const secret = randomBytes(32).toString("hex");
  const record: OAuthClient = {
    id,
    name: name.trim() || "Untitled client",
    secretHash: hashSecret(secret),
    redirectUris: redirectUris.filter((s) => typeof s === "string" && s.length > 0),
    scopes: scopes.length > 0 ? scopes : ["wsu:all"],
    createdAt: Date.now(),
  };
  doc.clients.push(record);
  save(doc);
  return { id, name: record.name, secret, redirectUris: record.redirectUris, scopes: record.scopes };
}

/** Rotate client secret; returns the new plaintext (shown once). */
export function rotateSecret(id: string): { secret: string } | null {
  const doc = load();
  const c = doc.clients.find((x) => x.id === id);
  if (!c) return null;
  const secret = randomBytes(32).toString("hex");
  c.secretHash = hashSecret(secret);
  save(doc);
  return { secret };
}

export function deleteClient(id: string): boolean {
  const doc = load();
  const before = doc.clients.length;
  doc.clients = doc.clients.filter((c) => c.id !== id);
  if (doc.clients.length === before) return false;
  save(doc);
  return true;
}

export function setRedirectUris(id: string, uris: string[]): OAuthClient | null {
  const doc = load();
  const c = doc.clients.find((x) => x.id === id);
  if (!c) return null;
  c.redirectUris = uris.filter((s) => typeof s === "string" && s.length > 0);
  save(doc);
  return c;
}

export function verifyClientSecret(id: string, secret: string): boolean {
  const c = getClient(id);
  if (!c) return false;
  const provided = Buffer.from(hashSecret(secret), "utf-8");
  const expected = Buffer.from(c.secretHash, "utf-8");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** Exact-match check against the client's whitelist. */
export function isRedirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

/**
 * Ensure at least one client named "ChatGPT" exists. Called on first visit to
 * the Settings OAuth section so the user has something to configure without
 * clicking "Add client" first. The returned plaintext secret is only defined
 * when a NEW client was created.
 */
export function ensureDefaultChatGptClient(): {
  client: OAuthClient;
  newSecret?: string;
} {
  const existing = load().clients.find((c) => c.name === "ChatGPT");
  if (existing) return { client: existing };
  const plain = registerClient("ChatGPT", [], ["wsu:all"]);
  const client = getClient(plain.id);
  if (!client) throw new Error("failed to persist default ChatGPT client");
  return { client, newSecret: plain.secret };
}
