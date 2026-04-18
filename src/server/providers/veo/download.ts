import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import { request } from "undici";

import { DOWNLOADS_DIR, ensureDirs } from "../../config";

export async function downloadToDisk(
  url: string,
  fileName: string,
  accessToken?: string,
  cookie?: string
): Promise<string> {
  ensureDirs();
  await mkdir(DOWNLOADS_DIR, { recursive: true });
  const absPath = path.join(DOWNLOADS_DIR, fileName);

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
}
