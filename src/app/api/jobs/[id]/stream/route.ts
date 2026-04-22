import { getJob, subscribeJob, type JobEvent } from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE stream for a single job. Emits the initial snapshot then forwards every
 * event from the queue's EventEmitter. The stream closes itself when the job
 * reaches a terminal state (done / error / cancelled).
 *
 * Previous implementation crashed with `ERR_INVALID_STATE: Controller is already
 * closed` whenever the client disconnected mid-stream because:
 *   1. `send()` enqueued into a controller that was already closed by the browser.
 *   2. Cleanup lived in a `start()`-returned function, which ReadableStream does
 *      NOT call (only `cancel()` is called on disconnect).
 *
 * The throw bubbled through `EventEmitter.emit` → `setJobError` → the POST
 * /api/jobs `.catch` handler, which produced an unhandledRejection, and also
 * prevented later listeners from firing. End result: the lane's `active` counter
 * sometimes stayed stuck → every subsequent job sat in "queued" forever.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (unsub) {
      try { unsub(); } catch { /* ignore */ }
      unsub = null;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // Controller closed unexpectedly (client disconnected). Tear everything
          // down so subsequent events don't retry enqueueing.
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }
      };

      const snapshot = getJob(id);
      if (snapshot) send({ type: "snapshot", job: snapshot });

      unsub = subscribeJob(id, (ev: JobEvent) => {
        send(ev);
        if (
          ev.type === "status" &&
          (ev.status === "done" || ev.status === "error" || ev.status === "cancelled")
        ) {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }
      });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        }
      }, 15_000);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
