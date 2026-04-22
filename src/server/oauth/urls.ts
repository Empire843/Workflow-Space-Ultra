/**
 * Public OAuth URL helpers — relocated from `@/server/config` so the
 * OAuth module is self-contained.
 *
 * `publicBaseUrl` is set once via `initOAuthUrls()` at app bootstrap;
 * defaults to `http://localhost:3000` when unset (same as the old
 * `PUBLIC_BASE_URL` constant).
 */

let _publicBaseUrl: string | undefined;

/**
 * Initialise the public base URL used by `oauthPublicUrls()` and
 * `isPublicBaseUrlLocal()`.  Pass the value of `WSU_PUBLIC_BASE_URL`
 * (or whatever the app resolves to) at startup.
 */
export function initOAuthUrls(publicBaseUrl: string): void {
  _publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
}

function baseUrl(): string {
  return _publicBaseUrl ?? (process.env.WSU_PUBLIC_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function isPublicBaseUrlLocal(): boolean {
  try {
    const u = new URL(baseUrl());
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local")
    );
  } catch {
    return true;
  }
}

/** The 4 URLs a user needs to paste into ChatGPT Actions config. */
export function oauthPublicUrls() {
  const base = baseUrl();
  return {
    authorizationUrl: `${base}/api/oauth/authorize`,
    tokenUrl: `${base}/api/oauth/token`,
    revokeUrl: `${base}/api/oauth/revoke`,
    openapiUrl: `${base}/api/actions/openapi`,
  };
}
