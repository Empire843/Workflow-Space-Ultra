import path from "node:path";
import { existsSync, rmSync, unlinkSync } from "node:fs";

import { NextResponse } from "next/server";

import {
  DATA_GENERAL_DIR,
  GROK_PROFILE_NAME,
  GROK_USER_DATA_ROOT,
  VEO_USER_DATA_DIR,
} from "@/server/config";
import { killChromeForUserData } from "@/server/chrome/processManager";
import { resolveGrokProfileDir } from "@/server/chrome/grokChromeManager";
import { resetGrokCollector } from "@/server/tokens/grokTokenCollector";
import { sessionTelemetry } from "@/server/tokens/sessionTelemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full-wipe logout.
 *
 * Previously this route just deleted the JSON token cache — cookies in
 * the Chrome user-data-dir stayed, which meant "logout" didn't actually
 * log anyone out. Re-login silently reused the old session and inherited
 * whatever state caused the user to hit the logout button in the first
 * place (e.g. a bad x-statsig-id baked into local storage).
 *
 * The new flow, for each target, is best-effort and strictly ordered:
 *
 *   1. Drop the in-process singleton collector so the next request
 *      reconnects fresh.
 *   2. Kill any Chrome processes still holding the profile open
 *      (so step 3 doesn't hit "file in use" on Windows).
 *   3. Delete the token cache file / profile entry.
 *   4. `rm -rf` the user-data-dir.
 *
 * Each step logs into the `steps` array in the response so the UI can
 * show exactly what happened — useful when one step fails (e.g. Chrome
 * refused SIGTERM) and the user wonders why cookies are still there.
 */

type Target = "veo" | "grok" | "all";

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

function safeUnlink(file: string): StepResult {
  try {
    if (existsSync(file)) unlinkSync(file);
    return { step: `unlink ${path.basename(file)}`, ok: true };
  } catch (err) {
    return {
      step: `unlink ${path.basename(file)}`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function safeRmDir(dir: string): StepResult {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    }
    return { step: `rm -rf ${path.basename(dir)}`, ok: true };
  } catch (err) {
    return {
      step: `rm -rf ${path.basename(dir)}`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function wipeVeo(): Promise<StepResult[]> {
  const steps: StepResult[] = [];

  // Step 1: drop singleton (the global store holds the Chrome handle).
  try {
    const g = globalThis as unknown as Record<string, { instance?: { close?: () => Promise<void> } | null; initPromise?: unknown } | undefined>;
    const store = g["__veoTokenCollectorSingleton__"];
    const inst = store?.instance;
    if (inst?.close) {
      try { await inst.close(); } catch { /* ignore */ }
    }
    if (store) {
      store.instance = null;
      store.initPromise = null;
    }
    steps.push({ step: "drop veo singleton", ok: true });
  } catch (err) {
    steps.push({
      step: "drop veo singleton",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2: kill Chrome holding the profile so step 4 can rm -rf.
  try {
    killChromeForUserData(VEO_USER_DATA_DIR);
    steps.push({ step: "kill veo chrome", ok: true });
  } catch (err) {
    steps.push({
      step: "kill veo chrome",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: delete cache file
  steps.push(safeUnlink(path.join(DATA_GENERAL_DIR, "veo_tokens_cache.json")));

  // Step 4: blow away the Chrome user-data-dir
  steps.push(safeRmDir(VEO_USER_DATA_DIR));

  return steps;
}

async function wipeGrok(profileName: string): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const profileDir = resolveGrokProfileDir(profileName);

  // Step 1: drop singleton
  try {
    resetGrokCollector();
    steps.push({ step: "drop grok singleton", ok: true });
  } catch (err) {
    steps.push({
      step: "drop grok singleton",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 2: kill Chrome
  try {
    killChromeForUserData(profileDir);
    steps.push({ step: "kill grok chrome", ok: true });
  } catch (err) {
    steps.push({
      step: "kill grok chrome",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 3: prune the profile entry from grok_cache.json (don't nuke the
  // entire cache — other profiles stay intact).
  const cacheFile = path.join(DATA_GENERAL_DIR, "grok_cache.json");
  try {
    if (existsSync(cacheFile)) {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const data = JSON.parse(readFileSync(cacheFile, "utf-8")) as {
        profiles?: Record<string, unknown>;
      };
      if (data.profiles && data.profiles[profileName]) {
        delete data.profiles[profileName];
        writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
        steps.push({ step: `prune grok_cache[${profileName}]`, ok: true });
      } else {
        steps.push({ step: `prune grok_cache[${profileName}]`, ok: true, detail: "absent" });
      }
    } else {
      steps.push({ step: `prune grok_cache[${profileName}]`, ok: true, detail: "no file" });
    }
  } catch (err) {
    steps.push({
      step: `prune grok_cache[${profileName}]`,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 4: wipe the profile directory only — never the whole
  // `GROK_USER_DATA_ROOT`, because other profiles live under it.
  if (profileDir.startsWith(GROK_USER_DATA_ROOT + path.sep)) {
    steps.push(safeRmDir(profileDir));
  } else {
    steps.push({
      step: `rm -rf ${path.basename(profileDir)}`,
      ok: false,
      detail: "profile dir is outside GROK_USER_DATA_ROOT — refusing",
    });
  }

  return steps;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    target?: Target;
    profileName?: string;
  };
  const t: Target = body.target || "all";
  const profileName = body.profileName || GROK_PROFILE_NAME;
  const started = Date.now();
  const allSteps: StepResult[] = [];

  if (t === "veo" || t === "all") {
    const s = await wipeVeo();
    allSteps.push(...s);
    sessionTelemetry.record({
      target: "veo",
      kind: "logout",
      durationMs: Date.now() - started,
      detail: s.map((x) => `${x.step}=${x.ok ? "ok" : "fail"}`).join(";"),
    });
  }
  if (t === "grok" || t === "all") {
    const s = await wipeGrok(profileName);
    allSteps.push(...s);
    sessionTelemetry.record({
      target: "grok",
      kind: "logout",
      durationMs: Date.now() - started,
      detail: s.map((x) => `${x.step}=${x.ok ? "ok" : "fail"}`).join(";"),
    });
  }

  const ok = allSteps.every((x) => x.ok);
  return NextResponse.json({ ok, steps: allSteps });
}
