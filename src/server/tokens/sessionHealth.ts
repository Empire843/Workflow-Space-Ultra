import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { DATA_GENERAL_DIR, GROK_PROFILE_NAME } from "../config";

/**
 * Truthful session health helper — single source of truth for the UI
 * `/api/auth/status` endpoint, the pre-warm scheduler and the logout flow.
 *
 * The old status route treated "file exists on disk" as `ok: true`. That
 * lied as soon as the Google access_token crossed the 45-minute mark: the
 * badge stayed green but every job died with a 401. Now we compute a
 * tri-state based on `updatedAt` age vs a provider-specific TTL, mirroring
 * the `loadCachedVeoAuth` invalidation but without discarding the tokens.
 *
 *   fresh   — age < TTL * 0.8  (badge green)
 *   stale   — age in [0.8*TTL, TTL)  (badge amber, pre-warm eligible)
 *   expired — age >= TTL OR cache missing / malformed
 */

export type AuthStatusKind = "fresh" | "stale" | "expired";

export interface AuthHealth {
  status: AuthStatusKind;
  ageMs: number | null;
  updatedAt: string | null;
  chromeConnected: boolean;
  /** Optional human-readable reason for "expired" — surfaced to telemetry. */
  reason?: string;
  /** Provider-specific extras kept for the client. */
  projectId?: string | null; // veo
  profileName?: string; // grok
}

// Google OAuth access tokens live ~1h; we use 45min as the hard ceiling to
// avoid racing the real expiry (same number `loadCachedVeoAuth` uses).
export const VEO_TTL_MS = 45 * 60_000;
// Grok cookies rotate much faster than statsig itself; 2h is a conservative
// middle ground that keeps the amber window generous enough to catch the
// rotation on the next pre-warm tick.
export const GROK_TTL_MS = 2 * 60 * 60_000;
const STALE_FRACTION = 0.8;
// If the cache file is this young, we trust it even when the in-process
// collector singleton reports Chrome as disconnected — this is the normal
// state right after Next.js server startup where nothing has called
// `getVeoCollector()` yet, so flashing amber immediately would confuse the
// user. After the window, we escalate to amber/stale so auto-prewarm kicks
// in and re-attaches Chrome before the user clicks create.
const CHROME_DISCONNECT_GRACE_MS = 5 * 60_000;

interface VeoCache {
  sessionId?: string;
  projectId?: string;
  accessToken?: string;
  updatedAt?: string;
}

interface GrokCacheEntry {
  custom_headers?: { "x-statsig-id"?: string };
  updated_at?: string;
}

interface GrokCacheFile {
  profiles?: Record<string, GrokCacheEntry>;
}

function safeRead<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function classifyAge(ageMs: number | null, ttlMs: number): AuthStatusKind {
  if (ageMs == null || !Number.isFinite(ageMs)) return "expired";
  if (ageMs < 0) return "fresh"; // clock skew guard — treat as fresh
  if (ageMs >= ttlMs) return "expired";
  if (ageMs >= ttlMs * STALE_FRACTION) return "stale";
  return "fresh";
}

/**
 * Demote `fresh` → `stale` when the in-process Chrome handle is known dead
 * (user closed the window, CDP socket dropped, HMR wiped the singleton).
 * The cache file may still be young, but every downstream API call needs a
 * live Chrome; without this demotion the badge stays green for up to 36
 * minutes while every create-image request fails with "Không bắt được
 * recaptcha token". We keep the very-first-minutes grace so a brand-new
 * server start doesn't flash amber before anyone had a chance to use the
 * tool (the singleton is only created on demand).
 */
function combineWithChromeLiveness(
  status: AuthStatusKind,
  ageMs: number | null,
  chromeConnected: boolean,
): { status: AuthStatusKind; reason?: string } {
  if (status !== "fresh") return { status };
  if (chromeConnected) return { status };
  if (ageMs != null && ageMs < CHROME_DISCONNECT_GRACE_MS) return { status };
  return { status: "stale", reason: "chrome-disconnected" };
}

/**
 * Peek at the singleton store WITHOUT initialising — used by the status
 * endpoint so simply opening the dashboard doesn't spin up Chrome just to
 * paint the badge. The collector modules stash their singletons on
 * `globalThis` via fixed keys; we read the same slot here.
 */
function peekVeoChromeConnected(): boolean {
  try {
    const g = globalThis as unknown as Record<string, { instance?: { isAlive?: () => boolean } } | undefined>;
    const store = g["__veoTokenCollectorSingleton__"];
    const inst = store?.instance;
    if (!inst || typeof inst.isAlive !== "function") return false;
    return !!inst.isAlive();
  } catch {
    return false;
  }
}

function peekGrokChromeConnected(): boolean {
  try {
    const g = globalThis as unknown as Record<string, { instance?: { isAlive?: () => boolean } } | undefined>;
    const store = g["__grokTokenCollectorSingleton__"];
    const inst = store?.instance;
    if (!inst || typeof inst.isAlive !== "function") return false;
    return !!inst.isAlive();
  } catch {
    return false;
  }
}

export function computeVeoHealth(): AuthHealth {
  const file = path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json");
  const chromeConnected = peekVeoChromeConnected();
  const cache = safeRead<VeoCache>(file);
  if (!cache || !cache.sessionId || !cache.projectId || !cache.accessToken) {
    return {
      status: "expired",
      ageMs: null,
      updatedAt: null,
      chromeConnected,
      reason: cache ? "missing-fields" : "no-cache",
      projectId: null,
    };
  }
  const updated = cache.updatedAt ? Date.parse(cache.updatedAt) : NaN;
  const ageMs = Number.isFinite(updated) ? Date.now() - updated : null;
  const rawStatus = classifyAge(ageMs, VEO_TTL_MS);
  const combined = combineWithChromeLiveness(rawStatus, ageMs, chromeConnected);
  return {
    status: combined.status,
    ageMs,
    updatedAt: cache.updatedAt || null,
    chromeConnected,
    reason:
      combined.status === "expired"
        ? "ttl-exceeded"
        : combined.reason,
    projectId: cache.projectId,
  };
}

export function computeGrokHealth(profileName: string = GROK_PROFILE_NAME): AuthHealth {
  const file = path.join(DATA_GENERAL_DIR, "grok_cache.json");
  const chromeConnected = peekGrokChromeConnected();
  const cache = safeRead<GrokCacheFile>(file);
  const entry = cache?.profiles?.[profileName];
  if (!entry?.custom_headers?.["x-statsig-id"]) {
    return {
      status: "expired",
      ageMs: null,
      updatedAt: null,
      chromeConnected,
      reason: entry ? "missing-statsig" : "no-profile-entry",
      profileName,
    };
  }
  const updated = entry.updated_at ? Date.parse(entry.updated_at) : NaN;
  const ageMs = Number.isFinite(updated) ? Date.now() - updated : null;
  const rawStatus = classifyAge(ageMs, GROK_TTL_MS);
  const combined = combineWithChromeLiveness(rawStatus, ageMs, chromeConnected);
  return {
    status: combined.status,
    ageMs,
    updatedAt: entry.updated_at || null,
    chromeConnected,
    reason:
      combined.status === "expired"
        ? "ttl-exceeded"
        : combined.reason,
    profileName,
  };
}

export type SessionTarget = "veo" | "grok";

export function computeAuthHealth(target: SessionTarget): AuthHealth {
  return target === "veo" ? computeVeoHealth() : computeGrokHealth();
}
