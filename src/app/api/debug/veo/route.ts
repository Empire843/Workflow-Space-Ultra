import { NextResponse } from "next/server";

import { getVeoCollector } from "@/server/tokens/veoTokenCollector";
import { findRunningCdpPortForUserData } from "@/server/chrome/processManager";
import { VEO_USER_DATA_DIR } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inspect state directly:
 * - Which port is Chrome running on for the VEO profile?
 * - What URL is the Playwright page on?
 * - Does window.__NEXT_DATA__ have an access_token?
 * - Can grecaptcha.enterprise.execute be called?
 */
export async function GET() {
  const out: Record<string, unknown> = {};

  try {
    out.userDataDir = VEO_USER_DATA_DIR;
    out.runningCdpPort = findRunningCdpPortForUserData(VEO_USER_DATA_DIR);
  } catch (e) {
    out.runningCdpPortError = e instanceof Error ? e.message : String(e);
  }

  let collector: Awaited<ReturnType<typeof getVeoCollector>> | null = null;
  try {
    collector = await getVeoCollector();
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
    const dom = await page.evaluate(() => {
      type NextData = {
        props?: { pageProps?: { session?: { access_token?: string } } };
      };
      const nd = (window as unknown as { __NEXT_DATA__?: NextData }).__NEXT_DATA__;
      type GEnt = { execute?: (k: string, o: { action: string }) => Promise<string> };
      type W = Window & { grecaptcha?: { enterprise?: GEnt } & GEnt };
      const w = window as unknown as W;
      return {
        hasNextData: !!nd,
        nextDataKeys: nd?.props?.pageProps ? Object.keys(nd.props.pageProps) : [],
        hasAccessToken: !!nd?.props?.pageProps?.session?.access_token,
        accessTokenPreview: nd?.props?.pageProps?.session?.access_token?.slice(0, 12) || null,
        hasGrecaptcha: !!w.grecaptcha,
        hasGrecaptchaEnterprise: !!w.grecaptcha?.enterprise,
        hasEnterpriseExecute: !!w.grecaptcha?.enterprise?.execute,
        documentReadyState: document.readyState,
        cookieLength: (document.cookie || "").length,
      };
    });
    out.dom = dom;
  } catch (e) {
    out.domError = e instanceof Error ? e.message : String(e);
  }

  try {
    // Try executing recaptcha and return the token directly
    const recap = await page.evaluate(async () => {
      type GEnt = {
        ready?: (cb: () => void) => void;
        execute?: (k: string, o: { action: string }) => Promise<string>;
      };
      type W = Window & { grecaptcha?: { enterprise?: GEnt } };
      const w = window as unknown as W;
      const g = w.grecaptcha?.enterprise;
      if (!g?.execute) return { ok: false, reason: "no grecaptcha.enterprise.execute" };
      try {
        await new Promise<void>((r) => (g.ready ? g.ready(() => r()) : r()));
        const t = await g.execute("6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV", { action: "probe" });
        return { ok: true, tokenPreview: t?.slice(0, 20) || null };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    });
    out.recaptchaProbe = recap;
  } catch (e) {
    out.recaptchaProbeError = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json(out, { status: 200 });
}
