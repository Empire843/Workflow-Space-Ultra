import { NextResponse } from "next/server";

import { PUBLIC_BASE_URL, isPublicBaseUrlLocal, oauthPublicUrls } from "@/server/config";
import { requireLocalhost } from "@/server/oauth/localGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only config snapshot consumed by the Settings → OAuth section. Lists
 * the exact URLs the user should paste into the ChatGPT Custom GPT Action
 * editor + a warning flag when the tool is still on `localhost` (i.e. the
 * tunnel is not yet running, so the flow will not work end-to-end).
 */
export async function GET(req: Request): Promise<Response> {
  const forbid = requireLocalhost(req);
  if (forbid) return forbid;
  return NextResponse.json({
    publicBaseUrl: PUBLIC_BASE_URL,
    isLocal: isPublicBaseUrlLocal(),
    urls: oauthPublicUrls(),
  });
}
