import { request } from "undici";

import type { Page } from "playwright";

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

/**
 * POST a JSON payload **through the Chrome browser context** instead of Node.
 *
 * Why this exists: the VEO `aisandbox-pa.googleapis.com` endpoints are gated
 * by reCAPTCHA Enterprise risk analysis. Google binds each recaptcha token
 * to the request environment that *produced* it — TLS fingerprint, User-
 * Agent, Sec-CH-UA, Origin, Referer, cookies (including HttpOnly). A token
 * minted by `grecaptcha.enterprise.execute()` inside the logged-in Chrome
 * tab scores ~0.9 when the follow-up API call comes from that *same* tab;
 * if we instead relay it through Node+undici the score drops to ~0.3 and
 * `PUBLIC_ERROR_UNUSUAL_ACTIVITY` starts firing.
 *
 * Using `page.context().request.post(...)` routes the call through the
 * browser's own networking stack → all of the above fingerprint bits match
 * automatically, so the token is accepted every time.
 *
 * The Python reference tool calls this "Option 2" (see
 * `request_create_video_via_browser` in API_text_to_video.py).
 */
export async function postJsonViaBrowser(
  page: Page,
  url: string,
  payload: unknown,
  accessToken: string,
  timeoutMs = 60_000,
): Promise<HttpResult> {
  const shortUrl = url.length > 120 ? `${url.slice(0, 117)}...` : url;
  console.log(`[VEO] route post via browser → ${shortUrl}`);

  // Dev-only: set `VEO_FORCE_403=1` in env to simulate Google refusing
  // the request with PUBLIC_ERROR_UNUSUAL_ACTIVITY. Lets the 403-ladder
  // in `withRecaptcha` / `CreateImageBatcher.dispatchSingle` be exercised
  // without waiting for a real flag. Prod users never set this.
  if (process.env.VEO_FORCE_403 === "1") {
    console.warn("[VEO] VEO_FORCE_403=1 — returning synthetic 403 UNUSUAL_ACTIVITY");
    return {
      ok: false,
      status: 403,
      body: JSON.stringify({
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "PUBLIC_ERROR_UNUSUAL_ACTIVITY (forced by VEO_FORCE_403)",
        },
      }),
      headers: { "content-type": "application/json" },
      url,
    };
  }

  try {
    const resp = await page.context().request.post(url, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      data: payload as Record<string, unknown>,
      timeout: timeoutMs,
      failOnStatusCode: false,
    });
    const status = resp.status();
    const text = await resp.text();
    const rawHeaders = resp.headers();
    const normalizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      normalizedHeaders[k.toLowerCase()] = String(v ?? "");
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      body: text,
      headers: normalizedHeaders,
      url,
    };
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
