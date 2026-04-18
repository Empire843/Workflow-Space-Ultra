import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Proxy download: fetch an external URL and stream it to the client with a
 * Content-Disposition: attachment header to trigger Save-As. Avoids CORS +
 * inline-display for GCS-hosted images/videos.
 *
 * Host allowlist so this route doesn't become an open proxy.
 * For assets.grok.com: use the Playwright page (cookie session) instead of raw fetch.
 */
const ALLOWED_HOST_SUFFIXES = [
  ".googleapis.com",
  ".google.com",
  ".ggpht.com",
  ".googleusercontent.com",
  ".grok.com",
  ".x.ai",
  ".twimg.com",
];

function hostAllowed(url: URL): boolean {
  const h = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s.replace(/^\./, "") || h.endsWith(s));
}

function isGrokAsset(url: URL): boolean {
  return url.hostname.toLowerCase().includes("grok.com");
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 200) || "download";
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const rawTarget = u.searchParams.get("url");
  const fname = u.searchParams.get("filename") || "download";
  if (!rawTarget) return NextResponse.json({ ok: false, message: "missing url" }, { status: 400 });

  // Grok sometimes returns a relative URL like `users/<uid>/generated/.../file.mp4`.
  // If there's no http(s) scheme, resolve it to https://assets.grok.com/… so that
  // older UI/preview entries (persisted in IndexedDB) still download after the fix.
  const target = /^https?:\/\//i.test(rawTarget)
    ? rawTarget
    : `https://assets.grok.com/${rawTarget.replace(/^\/+/, "")}`;

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ ok: false, message: "invalid url" }, { status: 400 });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json({ ok: false, message: "bad protocol" }, { status: 400 });
  }
  if (!hostAllowed(parsed)) {
    return NextResponse.json({ ok: false, message: `host not allowed: ${parsed.hostname}` }, { status: 403 });
  }

  const filename = sanitizeFilename(fname);

  // Grok assets need a cookie session → proxy through the Playwright page
  if (isGrokAsset(parsed)) {
    try {
      const { grokProxyFetch } = await import("@/server/providers/grok");
      const result = await grokProxyFetch(parsed.toString());
      if (result.status < 200 || result.status >= 300) {
        return NextResponse.json(
          { ok: false, message: `Grok asset returned ${result.status}` },
          { status: result.status },
        );
      }
      const headers = new Headers();
      headers.set("content-type", result.contentType);
      headers.set("content-disposition", `attachment; filename="${filename}"`);
      headers.set("content-length", String(result.body.length));
      headers.set("cache-control", "no-store");
      return new Response(new Uint8Array(result.body), { status: 200, headers });
    } catch (err) {
      console.error("[download] Grok proxy failed:", err);
      return NextResponse.json(
        { ok: false, message: `Grok proxy download failed: ${err instanceof Error ? err.message : err}` },
        { status: 502 },
      );
    }
  }

  // Standard download via undici
  const { request } = await import("undici");
  const res = await request(parsed.toString(), {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 workflow-space-ultra",
    },
  });

  const contentType =
    (res.headers["content-type"] as string | undefined) || "application/octet-stream";
  const contentLength = res.headers["content-length"] as string | undefined;

  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  if (contentLength) headers.set("content-length", contentLength);
  headers.set("cache-control", "no-store");

  return new Response(res.body as unknown as BodyInit, {
    status: res.statusCode,
    headers,
  });
}
