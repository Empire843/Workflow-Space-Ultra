/**
 * Gate that only lets requests originating from the local machine through.
 *
 * When `WSU_PUBLIC_BASE_URL` points at a tunnel (ngrok, cloudflared …) the
 * OAuth admin endpoints MUST stay local — otherwise a leaked tunnel URL would
 * let an attacker register or rotate OAuth clients remotely. ChatGPT's own
 * OAuth calls (`/api/oauth/authorize`, `/api/oauth/token`, `/api/actions/*`)
 * go through the `requireOAuth` / code-flow path and are immune to this
 * guard.
 *
 * Detection heuristics (cheap + robust for Next.js runtimes):
 *   1. `Host:` header ends with `localhost`, starts with `127.` or is `::1`
 *      (Next dev server preserves the header verbatim).
 *   2. Fallback: the URL's host itself matches (covers production where the
 *      server is launched with a specific hostname).
 */

const LOCAL_HOST_PATTERNS = [
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/i,
];

export function isLocalhostRequest(req: Request): boolean {
  const hostHeader = req.headers.get("host");
  const url = (() => {
    try {
      return new URL(req.url);
    } catch {
      return null;
    }
  })();
  const candidates = [hostHeader, url?.host].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return candidates.some((h) => LOCAL_HOST_PATTERNS.some((re) => re.test(h)));
}

export function requireLocalhost(req: Request): Response | null {
  if (isLocalhostRequest(req)) return null;
  return new Response(
    JSON.stringify({
      error: "forbidden",
      error_description:
        "This endpoint is only accessible from localhost. Use the WSU Settings UI on the host machine.",
    }),
    {
      status: 403,
      headers: { "content-type": "application/json" },
    },
  );
}

