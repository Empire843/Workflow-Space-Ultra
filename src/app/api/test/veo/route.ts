import { NextResponse } from "next/server";

import { getVeoCollector } from "@/server/tokens/veoTokenCollector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const col = await getVeoCollector();
    const auth = await col.collectAuth({ timeoutMs: 45_000 });

    // Recaptcha is optional: this is just a smoke test. It's fine if grecaptcha hasn't loaded
    // on the project page yet — it will load when the user actually generates a video.
    let recapMsg = " (recaptcha sẽ lấy khi generate)";
    try {
      const recap = await col.getFreshRecaptchaToken(10_000);
      if (recap) recapMsg = ` recaptcha=${recap.slice(0, 10)}…`;
    } catch {
      // ignore, don't block verify
    }

    return NextResponse.json({
      ok: true,
      message: `Login OK · project=${auth.projectId.slice(0, 8)}…${recapMsg}`,
      projectId: auth.projectId,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
