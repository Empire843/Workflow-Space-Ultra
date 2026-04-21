import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DATA_GENERAL_DIR } from "@/server/config";

/**
 * Shared on-disk JSON store helpers for the OAuth module.
 *
 * Everything lives under `data_general/oauth/` alongside the VEO/Grok session
 * caches — single-user local app, one file per logical store, written
 * synchronously because traffic is tiny (≤ a few writes per day for a typical
 * GPT Action workflow).
 */

/**
 * Compute the OAuth data directory on every call so tests can redirect the
 * store to a temp dir by setting `WSU_OAUTH_DIR` in `beforeAll` / `beforeEach`.
 * In production the env var is unset and we always resolve to
 * `<cwd>/data_general/oauth/`.
 */
export function oauthDir(): string {
  const override = process.env.WSU_OAUTH_DIR;
  if (override && override.length > 0) return override;
  return path.join(DATA_GENERAL_DIR, "oauth");
}

/** @deprecated kept for backwards-compat of early drafts; prefer `oauthDir()`. */
export const OAUTH_DIR = oauthDir();

export function ensureOAuthDir(): void {
  const dir = oauthDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(file: string, data: T): void {
  ensureOAuthDir();
  writeFileSync(file, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
}
