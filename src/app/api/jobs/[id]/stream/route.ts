import { getJob, subscribeJob } from "@/server/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      const snapshot = getJob(id);
      if (snapshot) {
        send({ type: "snapshot", job: snapshot });
      }

      const unsub = subscribeJob(id, (ev) => {
        send(ev);
        if (ev.type === "status" && (ev.status === "done" || ev.status === "error" || ev.status === "cancelled")) {
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      });

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // ignore
        }
      }, 15_000);

      (controller as ReadableStreamDefaultController & { closed?: boolean })["closed"] = false;

      return () => {
        clearInterval(heartbeat);
        unsub();
      };
    },
    cancel() {
      // no-op, cleanup in start's return
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
