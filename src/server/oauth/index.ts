/**
 * Barrel re-export for the OAuth module.
 *
 * Consumers should `import { … } from "@/server/oauth"` instead of
 * reaching into individual files.  The module is framework-agnostic —
 * it only depends on Node.js built-ins (`crypto`, `fs`, `path`)
 * and the Web-standard `Request` / `Response` APIs.
 */

// ── Bootstrap ──────────────────────────────────────────────────────
export { initOAuth, oauthDir, ensureOAuthDir, readJsonFile, writeJsonFile } from "./storage";

// ── Clients ────────────────────────────────────────────────────────
export {
  type OAuthClient,
  type PlainClient,
  listClients,
  getClient,
  registerClient,
  rotateSecret,
  deleteClient,
  setRedirectUris,
  verifyClientSecret,
  isRedirectUriAllowed,
  ensureDefaultChatGptClient,
} from "./clients";

// ── Authorization codes ────────────────────────────────────────────
export {
  type AuthCodeRecord,
  type ConsumeResult,
  issueAuthCode,
  consumeAuthCode,
  __clearAuthCodes,
} from "./codes";

// ── Tokens ─────────────────────────────────────────────────────────
export {
  type TokenType,
  type TokenRecord,
  type IssuedPair,
  type ValidatedAccess,
  type RejectedAccess,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  issueTokenPair,
  validateAccessToken,
  rotateRefreshToken,
  revokeToken,
  revokeAllForClient,
  __resetTokenStore,
} from "./tokens";

// ── Middleware (framework-agnostic) ────────────────────────────────
export { extractBearerToken, requireOAuth } from "./middleware";

// ── Localhost guard (framework-agnostic) ───────────────────────────
export { isLocalhostRequest, requireLocalhost } from "./localGuard";

// ── URL helpers ────────────────────────────────────────────────────
export { initOAuthUrls, isPublicBaseUrlLocal, oauthPublicUrls } from "./urls";
