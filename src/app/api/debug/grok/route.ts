import { NextResponse } from "next/server";

import { findRunningCdpPortForUserData } from "@/server/chrome/processManager";
import { resolveGrokProfileDir } from "@/server/chrome/grokChromeManager";
import { GROK_PROFILE_NAME } from "@/server/config";
import { computeGrokHealth } from "@/server/tokens/sessionHealth";
import { sessionTelemetry } from "@/server/tokens/sessionTelemetry";
import { getGrokCollector } from "@/server/tokens/grokTokenCollector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mirror of `/api/debug/veo`, useful when a user reports "session died
 * again" for Grok. Includes:
 *   - Current health (tri-state + age)
 *   - Running CDP port for the Grok profile
 *   - Page URL + cookie count + x-statsig-id presence
 *   - Last 50 session-telemetry events for Grok
 *
 * Unlike the VEO debug route this does NOT trigger a reCAPTCHA probe.
 */
export async function GET() {
  const out: Record<string, unknown> = {};
  out.health = computeGrokHealth();
  out.telemetry = sessionTelemetry.recent("grok", 50);

  const profileDir = resolveGrokProfileDir(GROK_PROFILE_NAME);
  out.profileDir = profileDir;
  try {
    out.runningCdpPort = findRunningCdpPortForUserData(profileDir);
  } catch (e) {
    out.runningCdpPortError = e instanceof Error ? e.message : String(e);
  }

  let collector: Awaited<ReturnType<typeof getGrokCollector>> | null = null;
  try {
    collector = await getGrokCollector(GROK_PROFILE_NAME);
  } catch (e) {
    out.collectorError = e instanceof Error ? e.message : String(e);
    return NextResponse.json(out);
  }

  const page = collector.getPage();
  if (!page) {
    out.error = "page not ready";
    return NextResponse.json(out);
  }

  try {
    out.pageUrl = page.url();
  } catch {
    // ignore
  }

  try {
    const cookies = await page.context().cookies(["https://grok.com", "https://www.grok.com"]);
    out.cookies = {
      count: cookies.length,
      names: cookies.map((c) => c.name),
      hasSso: cookies.some((c) => /^sso/i.test(c.name) && (c.value || "").length > 8),
    };
  } catch (e) {
    out.cookiesError = e instanceof Error ? e.message : String(e);
  }

  try {
    const dom = await page.evaluate(() => {
      try {
        const ls = localStorage.getItem("x-statsig-id");
        return {
          readyState: document.readyState,
          statsigInLocalStorage: Boolean(ls),
          statsigPreview: ls ? ls.slice(0, 20) : null,
          cookieLength: (document.cookie || "").length,
          url: window.location.href,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
    out.dom = dom;
  } catch (e) {
    out.domError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(out, { status: 200 });
}
