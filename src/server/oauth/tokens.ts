import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";

import { oauthDir, readJsonFile, writeJsonFile } from "./storage";

/**
 * Access + refresh token issuance and validation.
 *
 * Tokens are stored hashed (sha-256, same as client secrets). On every token
 * operation we lazily prune expired + revoked entries so `tokens.json` doesn't
 * grow unbounded across months of refreshes.
 *
 * A "token pair" is a linked access + refresh token sharing one `pairId`,
 * issued together by either the authorization-code flow or a refresh grant.
 * On refresh, the old pair is revoked and a new pair replaces it (token
 * rotation).
 */

export type TokenType = "access" | "refresh";

export interface TokenRecord {
  type: TokenType;
  tokenHash: string;
  pairId: string;
  clientId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked?: boolean;
}

interface TokensDoc {
  version: 1;
  tokens: TokenRecord[];
}

function tokensFile(): string {
  return path.join(oauthDir(), "tokens.json");
}

export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d

const EMPTY: TokensDoc = { version: 1, tokens: [] };

function load(): TokensDoc {
  const doc = readJsonFile<TokensDoc>(tokensFile(), EMPTY);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.tokens)) return { ...EMPTY };
  return doc;
}

function save(doc: TokensDoc): void {
  writeJsonFile(tokensFile(), doc);
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf-8").digest("hex");
}

function prune(doc: TokensDoc): TokensDoc {
  const now = Date.now();
  doc.tokens = doc.tokens.filter((t) => !t.revoked && t.expiresAt > now);
  return doc;
}

export interface IssuedPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds, matches OAuth response convention
  scopes: string[];
}

export function issueTokenPair(clientId: string, scopes: string[]): IssuedPair {
  const doc = prune(load());
  const pairId = randomBytes(12).toString("hex");
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const now = Date.now();
  doc.tokens.push({
    type: "access",
    tokenHash: hashToken(access),
    pairId,
    clientId,
    scopes,
    issuedAt: now,
    expiresAt: now + ACCESS_TTL_MS,
  });
  doc.tokens.push({
    type: "refresh",
    tokenHash: hashToken(refresh),
    pairId,
    clientId,
    scopes,
    issuedAt: now,
    expiresAt: now + REFRESH_TTL_MS,
  });
  save(doc);
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    scopes,
  };
}

export interface ValidatedAccess {
  ok: true;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

export interface RejectedAccess {
  ok: false;
  reason: "missing" | "not_found" | "expired" | "revoked" | "wrong_type";
}

/** Bearer token → {clientId, scopes} or rejection reason. */
export function validateAccessToken(raw: string | null | undefined): ValidatedAccess | RejectedAccess {
  if (!raw) return { ok: false, reason: "missing" };
  const doc = load();
  const providedHash = hashToken(raw);
  const providedBuf = Buffer.from(providedHash, "utf-8");
  for (const rec of doc.tokens) {
    const candidateBuf = Buffer.from(rec.tokenHash, "utf-8");
    if (candidateBuf.length !== providedBuf.length) continue;
    let match = false;
    try {
      match = timingSafeEqual(providedBuf, candidateBuf);
    } catch {
      match = false;
    }
    if (!match) continue;
    if (rec.revoked) return { ok: false, reason: "revoked" };
    if (rec.type !== "access") return { ok: false, reason: "wrong_type" };
    if (rec.expiresAt < Date.now()) return { ok: false, reason: "expired" };
    return { ok: true, clientId: rec.clientId, scopes: rec.scopes.slice(), expiresAt: rec.expiresAt };
  }
  return { ok: false, reason: "not_found" };
}

/**
 * Consume a refresh token and issue a new pair (rotation). The old pair
 * (both access and refresh) is revoked atomically. Returns null if the
 * refresh token is invalid for any reason.
 */
export function rotateRefreshToken(rawRefresh: string, clientId: string): IssuedPair | null {
  const doc = load();
  const providedHash = hashToken(rawRefresh);
  const providedBuf = Buffer.from(providedHash, "utf-8");
  let target: TokenRecord | undefined;
  for (const rec of doc.tokens) {
    const candidateBuf = Buffer.from(rec.tokenHash, "utf-8");
    if (candidateBuf.length !== providedBuf.length) continue;
    try {
      if (timingSafeEqual(providedBuf, candidateBuf)) {
        target = rec;
        break;
      }
    } catch {
      // keep scanning
    }
  }
  if (!target) return null;
  if (target.revoked || target.type !== "refresh") return null;
  if (target.expiresAt < Date.now()) return null;
  if (target.clientId !== clientId) return null;
  for (const rec of doc.tokens) {
    if (rec.pairId === target.pairId) rec.revoked = true;
  }
  save(prune(doc));
  return issueTokenPair(target.clientId, target.scopes);
}

/** Revoke every token whose raw value hashes to a match. */
export function revokeToken(raw: string): boolean {
  const doc = load();
  const providedHash = hashToken(raw);
  const providedBuf = Buffer.from(providedHash, "utf-8");
  let found = false;
  for (const rec of doc.tokens) {
    const candidateBuf = Buffer.from(rec.tokenHash, "utf-8");
    if (candidateBuf.length !== providedBuf.length) continue;
    try {
      if (timingSafeEqual(providedBuf, candidateBuf)) {
        for (const sibling of doc.tokens) {
          if (sibling.pairId === rec.pairId) sibling.revoked = true;
        }
        found = true;
        break;
      }
    } catch {
      // keep scanning
    }
  }
  if (found) save(prune(doc));
  return found;
}

export function revokeAllForClient(clientId: string): number {
  const doc = load();
  let n = 0;
  for (const rec of doc.tokens) {
    if (rec.clientId === clientId && !rec.revoked) {
      rec.revoked = true;
      n++;
    }
  }
  if (n > 0) save(prune(doc));
  return n;
}

/** Test-only helper: wipe everything. */
export function __resetTokenStore(): void {
  save({ ...EMPTY });
}
