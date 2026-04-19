import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Redirect LOGS_DIR to a per-test-run tempdir so we don't pollute the repo
// and so parallel runs don't race. The mock runs before `errorLog.ts`
// resolves the path.
const TMP = mkdtempSync(path.join(tmpdir(), "wsu-errorlog-"));
vi.mock("@/server/config", async (orig) => {
  const actual = await orig<typeof import("@/server/config")>();
  return { ...actual, LOGS_DIR: TMP };
});

// Import AFTER the mock is registered.
const { logError, getErrorLogPath } = await import("@/server/telemetry/errorLog");

afterAll(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("errorLog", () => {
  it("writes a single JSON line per call with ts/context/error", () => {
    const logFile = getErrorLogPath();
    logError({ context: "unit.test", error: new Error("boom"), extra: { jobId: "j1" } });

    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8");
    const lines = content.trim().split("\n");
    const last = lines[lines.length - 1];
    const parsed = JSON.parse(last);
    expect(parsed.context).toBe("unit.test");
    expect(parsed.error.name).toBe("Error");
    expect(parsed.error.message).toBe("boom");
    expect(typeof parsed.error.stack).toBe("string");
    expect(parsed.extra.jobId).toBe("j1");
    expect(typeof parsed.ts).toBe("string");
    expect(Number.isFinite(Date.parse(parsed.ts))).toBe(true);
    expect(parsed.pid).toBe(process.pid);
  });

  it("handles non-Error thrown values (strings, plain objects)", () => {
    const logFile = getErrorLogPath();
    logError({ context: "unit.string", error: "bare string" });
    logError({ context: "unit.object", error: { code: "E_FAIL", detail: 42 } });
    const lines = readFileSync(logFile, "utf-8").trim().split("\n").slice(-2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.error.value).toBe("bare string");
    expect(b.error.value).toEqual({ code: "E_FAIL", detail: 42 });
  });

  it("safely serializes circular references without throwing", () => {
    const logFile = getErrorLogPath();
    type Cyc = { self?: Cyc; name: string };
    const cyc: Cyc = { name: "loop" };
    cyc.self = cyc;
    expect(() =>
      logError({ context: "unit.circular", error: new Error("x"), extra: { cyc } })
    ).not.toThrow();
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.extra.cyc.self).toBe("[Circular]");
  });

  it("never throws even when called with exotic values", () => {
    expect(() => logError({ context: "unit.null", error: null })).not.toThrow();
    expect(() => logError({ context: "unit.undef", error: undefined })).not.toThrow();
    expect(() =>
      logError({ context: "unit.bigint", error: new Error("b"), extra: { n: 10n } })
    ).not.toThrow();
  });

  it("produces strictly valid JSON on every line", () => {
    const logFile = getErrorLogPath();
    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });
});

describe("errorLog path", () => {
  it("exposes the resolved log file path", () => {
    expect(getErrorLogPath()).toBe(path.join(TMP, "error.log"));
    const st = statSync(getErrorLogPath());
    expect(st.size).toBeGreaterThan(0);
  });
});

// Sanity: make sure we actually set up the mocked LOGS_DIR.
beforeAll(() => {
  expect(getErrorLogPath().startsWith(TMP)).toBe(true);
});
