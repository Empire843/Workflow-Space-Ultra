import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { request } from "undici";

import { ensureDirs } from "../../config";
import { resolveDownloadDir } from "../../paths/workflowAssets";
import { timedSpan } from "../../telemetry/timing";

/**
 * Stream a VEO asset (image/video) to disk. When `workflowRunId` is provided
 * the file lands under `Workflows/<id>/assets/outputs/` so it follows the
 * workflow across account switches; otherwise the legacy flat `downloads/`
 * folder is used (ad-hoc scripts, tests, or node runs without an open
 * workflow).
 */
export async function downloadToDisk(
  url: string,
  fileName: string,
  accessToken?: string,
  cookie?: string,
  workflowRunId?: string | null,
): Promise<string> {
  return timedSpan("veo.download", async () => {
    ensureDirs();
    const { dir } = resolveDownloadDir(workflowRunId);
    await mkdir(dir, { recursive: true });
    const absPath = path.join(dir, fileName);

    const headers: Record<string, string> = {};
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
    if (cookie) headers["Cookie"] = cookie;

    const { body, statusCode } = await request(url, { method: "GET", headers });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Download failed ${statusCode} ${url}`);
    }

    const out = createWriteStream(absPath);
    // body is a Readable from undici
    await finished(Readable.from(body).pipe(out));
    return absPath;
  });
}
