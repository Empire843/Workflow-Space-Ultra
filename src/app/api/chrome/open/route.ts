import { NextResponse } from "next/server";

import { GROK_CDP_HOST, GROK_PROFILE_NAME, VEO_CDP_HOST } from "@/server/config";
import { openGrokChrome } from "@/server/chrome/grokChromeManager";
import { openVeoChrome } from "@/server/chrome/veoChromeManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function forceWindowOnScreen(host: string, port: number, left: number, top: number) {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(`http://${host}:${port}`);
    const ctx = browser.contexts()[0];
    const page = ctx?.pages()[0] || (await ctx?.newPage());
    if (!ctx || !page) return;
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { left, top, width: 1280, height: 860, windowState: "normal" },
    });
    await cdp.detach();
    await browser.close().catch(() => undefined);
  } catch {
    // ignore
  }
}

/**
 * Just spawns (or reuses) Chrome for the VEO / Grok profile and navigates to the login URL.
 * Doesn't wait for token capture → meant for the user's first login.
 */
export async function POST(req: Request) {
  const { target, profileName } = (await req.json().catch(() => ({}))) as {
    target?: "veo" | "grok";
    profileName?: string;
  };
  if (!target) {
    return NextResponse.json({ ok: false, message: "target=veo|grok is required" }, { status: 400 });
  }
  try {
    if (target === "veo") {
      const handle = await openVeoChrome();
      await forceWindowOnScreen(VEO_CDP_HOST, handle.port, 40, 40);
      return NextResponse.json({
        ok: true,
        message: `Đã mở Chrome VEO tại CDP port ${handle.port}. Hãy đăng nhập Google account VEO 3 Ultra trong cửa sổ vừa mở, rồi BẤM 'New Project' hoặc mở 1 project bất kỳ trong Flow.`,
        port: handle.port,
        userDataDir: handle.userDataDir,
      });
    }
    const name = profileName || GROK_PROFILE_NAME;
    const handle = await openGrokChrome({ profileName: name });
    await forceWindowOnScreen(GROK_CDP_HOST, handle.port, 80, 80);
    return NextResponse.json({
      ok: true,
      message: `Đã mở Chrome Grok (profile ${name}) tại CDP port ${handle.port}. Hãy đăng nhập tài khoản Super Grok Heavy, rồi mở grok.com/imagine 1 lần.`,
      port: handle.port,
      userDataDir: handle.userDataDir,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
