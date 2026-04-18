import { vi } from "vitest";

export interface JobScript {
  /** ms delay → event to emit on SSE. Last event should be `status=done` or `status=error`. */
  events: Array<{ delay: number; payload: unknown }>;
}

/**
 * Scenario: map from nodeId → JobScript. `installFakeJobs` replaces globalThis.fetch
 * so /api/jobs returns a jobId, and the FakeEventSource setup in test/setup.ts
 * forwards messages whenever the helper emits for that jobId.
 */
export interface Scenario {
  scripts: Record<string, JobScript>;
}

let nextId = 1;

export function installFakeJobs(scenario: Scenario): {
  sentBodies: Array<{ nodeId: string; kind: string; payload: unknown }>;
  jobIdFor: Map<string, string>;
} {
  const sentBodies: Array<{ nodeId: string; kind: string; payload: unknown }> = [];
  const jobIdFor = new Map<string, string>();

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/jobs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const jobId = `job_${nextId++}`;
      jobIdFor.set(body.nodeId, jobId);
      sentBodies.push({ nodeId: body.nodeId, kind: body.kind, payload: body });
      const script = scenario.scripts[body.nodeId] ?? {
        events: [{ delay: 0, payload: { type: "status", status: "done" } }],
      };
      queueMicrotask(() => runScript(jobId, script));
      return new Response(JSON.stringify({ ok: true, jobId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;

  return { sentBodies, jobIdFor };
}

async function runScript(jobId: string, script: JobScript) {
  for (const ev of script.events) {
    if (ev.delay > 0) await new Promise((r) => setTimeout(r, ev.delay));
    else await new Promise((r) => setTimeout(r, 0));
    const emit = typeof window !== "undefined" ? window.__fakeJobEmitters?.get(jobId) : undefined;
    if (!emit) {
      console.warn(`[mockJobServer] no emitter for ${jobId} (event ${JSON.stringify(ev.payload).slice(0, 60)})`);
      continue;
    }
    emit(new MessageEvent("message", { data: JSON.stringify(ev.payload) }));
  }
}

export function successJob(output: Record<string, unknown> = {}): JobScript {
  return {
    events: [
      { delay: 0, payload: { type: "snapshot", job: { status: "running", progress: 1 } } },
      { delay: 0, payload: { type: "progress", progress: 50 } },
      {
        delay: 0,
        payload: { type: "output", output: { status: "done", progress: 100, ...output } },
      },
      { delay: 0, payload: { type: "status", status: "done" } },
    ],
  };
}

export function errorJob(message: string): JobScript {
  return {
    events: [
      { delay: 0, payload: { type: "error", error: message } },
      { delay: 0, payload: { type: "status", status: "error" } },
    ],
  };
}
