import { request } from "undici";

/**
 * HTTP wrapper using undici in place of Python's urllib.request.
 * Supports Bearer auth + optional cookie + JSON payload.
 */

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  url: string;
  error?: string;
}

export async function postJsonWithToken(
  url: string,
  payload: unknown,
  accessToken: string,
  cookie?: string,
  timeoutMs = 60_000
): Promise<HttpResult> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (cookie) headers["Cookie"] = cookie;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { statusCode, body, headers: resHeaders } = await request(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await body.text();
      const normalizedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(resHeaders)) {
        normalizedHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v || "");
      }
      return {
        ok: statusCode >= 200 && statusCode < 300,
        status: statusCode,
        body: text,
        headers: normalizedHeaders,
        url,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: "",
      headers: {},
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
