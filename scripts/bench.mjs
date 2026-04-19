#!/usr/bin/env node
// @ts-check
/**
 * Bench helper — reads `/api/jobs/metrics` and prints a readable table.
 *
 * Usage:
 *   node scripts/bench.mjs                       # default http://localhost:3000
 *   node scripts/bench.mjs --url=http://host:port
 *   node scripts/bench.mjs --json                # raw JSON (for piping)
 *   node scripts/bench.mjs --save baseline       # append to .docs/bench/<label>-<YYYY-MM-DD>.md
 *   node scripts/bench.mjs --reset               # clear the ring buffer (no snapshot)
 *
 * Workflow:
 *   1. Start dev: `npm run dev`
 *   2. Clear old stats: `npm run bench -- --reset`
 *   3. Run a representative workflow from the UI (same one each time).
 *   4. After completion: `npm run bench -- --save baseline`
 *   5. Apply a phase → reset → rerun workflow → `--save R1` → diff.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6);
const saveIdx = args.indexOf("--save");
const saveLabel = saveIdx >= 0 ? args[saveIdx + 1] : null;
const asJson = args.includes("--json");
const doReset = args.includes("--reset");

const base = urlArg || process.env.BENCH_URL || "http://localhost:3000";
const url = `${base.replace(/\/$/, "")}/api/jobs/metrics`;

if (doReset) {
  try {
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      console.error(`DELETE ${url} → ${res.status}`);
      process.exit(1);
    }
    const j = await res.json();
    console.log(`Ring buffer cleared at ${new Date(j.clearedAt).toISOString()}.`);
    process.exit(0);
  } catch (err) {
    console.error(`Reset failed (${url}): ${err?.message || err}`);
    process.exit(2);
  }
}

let payload;
try {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`GET ${url} → ${res.status}`);
    process.exit(1);
  }
  payload = await res.json();
} catch (err) {
  console.error(`Fetch failed (${url}): ${err?.message || err}`);
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const rows = payload.aggregates ?? [];
if (!rows.length) {
  console.log("No timing spans recorded yet. Run a workflow first.");
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

const header = [
  pad("span", 28),
  rpad("count", 6),
  rpad("err", 4),
  rpad("total(s)", 10),
  rpad("p50(ms)", 9),
  rpad("p95(ms)", 9),
  rpad("p99(ms)", 9),
  rpad("max(ms)", 9),
].join(" ");

const lines = [header, "-".repeat(header.length)];
for (const r of rows) {
  lines.push(
    [
      pad(r.name, 28),
      rpad(r.count, 6),
      rpad(r.errors, 4),
      rpad((r.totalMs / 1000).toFixed(1), 10),
      rpad(r.p50Ms, 9),
      rpad(r.p95Ms, 9),
      rpad(r.p99Ms, 9),
      rpad(r.maxMs, 9),
    ].join(" ")
  );
}

const output = lines.join("\n");
console.log(output);
console.log(`\n(${rows.length} spans · snapshot at ${new Date(payload.now).toISOString()})`);

if (saveLabel) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const dir = path.join(process.cwd(), ".docs", "bench");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${date}-${saveLabel}.md`);
  const md =
    `# Bench — ${saveLabel} · ${now.toISOString()}\n\n` +
    `Source: \`${url}\`\n\n` +
    "```\n" +
    output +
    "\n```\n";
  await writeFile(file, md, "utf8");
  console.log(`\nSaved → ${path.relative(process.cwd(), file)}`);
}
