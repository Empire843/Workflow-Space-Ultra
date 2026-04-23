/**
 * Minimal "stored" (STORE method, no compression) ZIP writer.
 *
 * Why a handwritten 50-liner instead of a library: WAV audio files don't
 * benefit from DEFLATE (already PCM, non-redundant), and the only consumer
 * is "Download all scenes" in the TTS flow. Pulling in JSZip/adm-zip for
 * this is ~150–400 KB of dead weight. The spec we implement is APPNOTE.TXT
 * §4.3, which is stable since 1989 — extract works in every OS unzip utility
 * including Finder and Explorer.
 *
 * Layout: [local file header + file data] × N  +  [central directory] + [EOCD]
 *
 * Limitations:
 *   - No compression (STORED method only)
 *   - No ZIP64 — files are capped at 4 GB combined (more than enough for WAV)
 *   - CRC-32 computed on each file, no streaming (we buffer everything)
 */

import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { deflateRaw as deflateRawCb } from "node:zlib";

// Unused but kept around in case we ever flip to DEFLATE for text payloads.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _deflate = promisify(deflateRawCb);

export interface ZipEntry {
  name: string;
  data: Buffer;
}

// CRC-32 as specified by ZIP (PKZip poly 0xEDB88320). 256-entry table cached
// at module load so large files don't pay the table-build cost per call.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a complete STORED ZIP. Returns a single Buffer the HTTP route can
 * stream straight back. `mtime` is fixed to epoch so the output is byte-stable
 * across calls — easier to test and to hash for integrity checks.
 */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  // (offset, nameBuf, crc, size) for each entry — needed when emitting the
  // central directory after all local headers are done.
  const cdEntries: Array<{
    offset: number;
    name: Buffer;
    crc: number;
    size: number;
  }> = [];

  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data;
    const crc = crc32(data);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);    // Local file header signature
    lfh.writeUInt16LE(20, 4);            // Version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6);        // Bit 11: UTF-8 filename flag
    lfh.writeUInt16LE(0, 8);             // Compression = STORED
    lfh.writeUInt16LE(0, 10);            // mod time = 0
    lfh.writeUInt16LE(0x0021, 12);       // mod date = 1980-01-01 (ZIP epoch)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);  // compressed size
    lfh.writeUInt32LE(data.length, 22);  // uncompressed size
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);            // extra field length

    parts.push(lfh, name, data);
    cdEntries.push({ offset, name, crc, size: data.length });
    offset += 30 + name.length + data.length;
  }

  const cdStart = offset;
  for (const c of cdEntries) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);    // Central directory header signature
    cdh.writeUInt16LE(20, 4);            // Version made by
    cdh.writeUInt16LE(20, 6);            // Version needed
    cdh.writeUInt16LE(0x0800, 8);        // UTF-8 flag
    cdh.writeUInt16LE(0, 10);            // STORED
    cdh.writeUInt16LE(0, 12);            // mod time
    cdh.writeUInt16LE(0x0021, 14);       // mod date
    cdh.writeUInt32LE(c.crc, 16);
    cdh.writeUInt32LE(c.size, 20);
    cdh.writeUInt32LE(c.size, 24);
    cdh.writeUInt16LE(c.name.length, 28);
    cdh.writeUInt16LE(0, 30);            // extra
    cdh.writeUInt16LE(0, 32);            // comment
    cdh.writeUInt16LE(0, 34);            // disk number
    cdh.writeUInt16LE(0, 36);            // internal attrs
    cdh.writeUInt32LE(0, 38);            // external attrs
    cdh.writeUInt32LE(c.offset, 42);     // relative offset of local header

    parts.push(cdh, c.name);
    offset += 46 + c.name.length;
  }

  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);     // End of central directory signature
  eocd.writeUInt16LE(0, 4);              // disk number
  eocd.writeUInt16LE(0, 6);              // disk with CD
  eocd.writeUInt16LE(cdEntries.length, 8);
  eocd.writeUInt16LE(cdEntries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);             // comment length

  parts.push(eocd);
  return Buffer.concat(parts);
}

/** Convenience for tests: SHA-256 of the zip output (byte-stable given
 *  fixed mtime). Not used by the route itself. */
export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
