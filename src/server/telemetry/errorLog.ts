import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { LOGS_DIR } from "../config";

/**
 * Dedicated error log.
 *
 * Design goals:
 *   1. One file, append-only JSON Lines (`logs/error.log`) that ONLY contains
 *      errors — no info/debug chatter mixed in. Easy to grep, easy to attach
 *      to a bug report, easy to rotate.
 *   2. Every entry has a full UTC ISO timestamp and a structured `context`
 *      string (e.g. "executor.runVeoT2V", "veo.withRecaptcha") so you can
 *      answer "what was running when this blew up?" without reading code.
 *   3. Arbitrary extra fields — jobId, nodeKind, URL, HTTP status, stack
 *      trace — are allowed but passed through JSON.stringify with a circular
 *      reference guard so a logger bug cannot break the caller.
 *   4. Rotation: when the file grows past ROTATE_SIZE_BYTES, it is renamed
 *      to `error.log.1`, with older rotations shifted up (max ROTATE_KEEP).
 *      We use rename instead of truncate so live tailing stays stable.
 *   5. Synchronous writes. Errors are infrequent by definition, so the
 *      simplicity of `appendFileSync` (no queue, no flush races, persists
 *      immediately even if the process crashes) outweighs the throughput
 *      cost. If that ever becomes a bottleneck, this file is the only
 *      thing that needs to change.
 */

const ERROR_LOG_FILE = path.join(LOGS_DIR, "error.log");
const ROTATE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ROTATE_KEEP = 5; // keeps error.log.1 ... error.log.5

export interface ErrorLogEntry {
  /** Dot-path describing where the error happened. */
  context: string;
  /** The thrown value (Error, string, or anything). */
  error: unknown;
  /** Optional structured metadata (jobId, nodeKind, url, ...). */
  extra?: Record<string, unknown>;
}

function ensureLogDir() {
  try {
    if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  } catch {
    // If the dir can't be created we silently drop the log — the tool must
    // never crash because error logging failed.
  }
}

function rotateIfNeeded() {
  try {
    if (!existsSync(ERROR_LOG_FILE)) return;
    const st = statSync(ERROR_LOG_FILE);
    if (st.size < ROTATE_SIZE_BYTES) return;

    // Shift error.log.(N-1) → error.log.N, dropping the oldest.
    for (let i = ROTATE_KEEP; i >= 1; i--) {
      const from = i === 1 ? ERROR_LOG_FILE : `${ERROR_LOG_FILE}.${i - 1}`;
      const to = `${ERROR_LOG_FILE}.${i}`;
      if (existsSync(from)) {
        try {
          if (existsSync(to)) {
            // drop the oldest by overwriting — renameSync replaces on both
            // POSIX and Windows when the destination exists, but Windows is
            // stricter about target presence for some tools, so we handle it.
          }
          renameSync(from, to);
        } catch {
          // ignore — the next write will try again
        }
      }
    }
  } catch {
    // ignore
  }
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    };
    if (err.stack) out.stack = err.stack;
    // Preserve additional fields some error classes attach (e.g. `cause`,
    // `code`, `status`). We deliberately don't enumerate prototypes — only
    // own enumerable properties — so we don't accidentally dump secrets.
    for (const k of Object.keys(err)) {
      if (k === "name" || k === "message" || k === "stack") continue;
      try {
        (out as Record<string, unknown>)[k] = (err as unknown as Record<string, unknown>)[k];
      } catch {
        // ignore getters that throw
      }
    }
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = serializeError(cause);
    return out;
  }
  if (typeof err === "object" && err !== null) {
    return { value: err };
  }
  return { value: String(err) };
}

/**
 * Serialize with a circular-reference guard. Never throws.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v as object)) return "[Circular]";
        seen.add(v as object);
      }
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
      return v;
    });
  } catch (err) {
    // Last-ditch fallback.
    return JSON.stringify({
      _serializationError: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Append a single error entry.
 *
 * Guarantees:
 *   - Never throws; safe to call from any catch block.
 *   - Always produces valid JSON on each line (JSON Lines format).
 *   - Writes synchronously so the error is on disk before the call returns.
 */
export function logError(entry: ErrorLogEntry): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    const record = {
      ts: new Date().toISOString(),
      context: entry.context,
      error: serializeError(entry.error),
      ...(entry.extra && Object.keys(entry.extra).length > 0
        ? { extra: entry.extra }
        : {}),
      pid: process.pid,
    };
    appendFileSync(ERROR_LOG_FILE, safeStringify(record) + "\n", "utf-8");
  } catch {
    // We must never let logging break the caller. Best effort only.
  }
}

/** The absolute path of the error log file (for UIs / docs). */
export function getErrorLogPath(): string {
  return ERROR_LOG_FILE;
}

/**
 * Install process-level error handlers exactly once per Node process.
 * Guarded via `globalThis` so HMR re-imports don't stack multiple listeners
 * (which would duplicate every entry on each code reload).
 *
 * This is the last line of defense: anything that escapes every other
 * try/catch (stray promise rejection, background timer throw, native
 * exception) still shows up in the error log with context `process.*`.
 */
const HANDLERS_KEY = "__wsu_error_log_handlers__";
function installProcessHandlers() {
  if (typeof process === "undefined") return;
  const g = globalThis as unknown as Record<string, boolean | undefined>;
  if (g[HANDLERS_KEY]) return;
  g[HANDLERS_KEY] = true;
  process.on("unhandledRejection", (reason) => {
    logError({ context: "process.unhandledRejection", error: reason });
  });
  process.on("uncaughtException", (err) => {
    logError({ context: "process.uncaughtException", error: err });
  });
  process.on("warning", (w) => {
    // Node emits `warning` for things like deprecation + memory leaks — log
    // them as errors too since they usually precede a real failure.
    if (w?.name === "DeprecationWarning") return; // too noisy
    logError({
      context: "process.warning",
      error: w,
      extra: { name: w?.name },
    });
  });
}
installProcessHandlers();
