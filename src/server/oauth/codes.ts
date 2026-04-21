import { createHash, randomBytes } from "node:crypto";

/**
 * Authorization-code store (in-memory, TTL-based).
 *
 * Codes are short-lived (60s), single-use, and cryptographically bound to the
 * client + redirect_uri + optional PKCE challenge that requested them. Since
 * WSU is single-process, an in-memory map is sufficient — a server restart
 * invalidates all pending codes, which is the safer default.
 */

export interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  issuedAt: number;
  expiresAt: number;
  used?: boolean;
}

const CODE_TTL_MS = 60_000;

const store = new Map<string, AuthCodeRecord>();

function cleanup(opts: { keepExpired?: boolean } = {}): void {
  const now = Date.now();
  for (const [code, rec] of store.entries()) {
    if (rec.used) store.delete(code);
    else if (!opts.keepExpired && rec.expiresAt < now) store.delete(code);
  }
}

export function issueAuthCode(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
}): string {
  cleanup();
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  store.set(code, {
    code,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    state: params.state,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    issuedAt: now,
    expiresAt: now + CODE_TTL_MS,
  });
  return code;
}

export interface ConsumeResult {
  ok: boolean;
  record?: AuthCodeRecord;
  error?: "unknown_code" | "expired" | "used" | "client_mismatch" | "redirect_mismatch" | "pkce_required" | "pkce_failed";
}

/**
 * Validate-and-consume a code. Even on failure the code is marked used so it
 * can't be retried (defence-in-depth against oracle attacks). Returns the
 * original record on success so caller can read bound scopes.
 */
export function consumeAuthCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier?: string;
}): ConsumeResult {
  // Only sweep out codes that were explicitly consumed. Leave expired
  // records in place so the caller still gets a distinct `expired` error
  // instead of `unknown_code` (useful for diagnostics; behaviour-equivalent
  // from the client's perspective).
  cleanup({ keepExpired: true });
  const rec = store.get(params.code);
  if (!rec) return { ok: false, error: "unknown_code" };
  if (rec.used) return { ok: false, error: "used" };
  if (rec.expiresAt < Date.now()) {
    store.delete(rec.code);
    return { ok: false, error: "expired" };
  }
  const markUsed = () => {
    rec.used = true;
    store.delete(rec.code);
  };
  if (rec.clientId !== params.clientId) {
    markUsed();
    return { ok: false, error: "client_mismatch" };
  }
  if (rec.redirectUri !== params.redirectUri) {
    markUsed();
    return { ok: false, error: "redirect_mismatch" };
  }
  if (rec.codeChallenge) {
    if (!params.codeVerifier) {
      markUsed();
      return { ok: false, error: "pkce_required" };
    }
    const method = rec.codeChallengeMethod ?? "plain";
    let derived: string;
    if (method === "S256") {
      derived = createHash("sha256").update(params.codeVerifier, "utf-8").digest("base64url");
    } else {
      derived = params.codeVerifier;
    }
    if (derived !== rec.codeChallenge) {
      markUsed();
      return { ok: false, error: "pkce_failed" };
    }
  }
  markUsed();
  return { ok: true, record: rec };
}

/** Test-only: clear the store. Not used at runtime. */
export function __clearAuthCodes(): void {
  store.clear();
}
