
import { engineSSEProxy } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const stream = engineSSEProxy();

  if (!stream) {
    const encoder = new TextEncoder();
    const fallback = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: "Engine unreachable" })}\n\n`,
          ),
        );
        const interval = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: heartbeat\ndata: ${JSON.stringify({ time: Date.now(), version: 0, clients: 0, engineConnected: false })}\n\n`,
              ),
            );
          } catch {
            clearInterval(interval);
          }
        }, 30_000);

        request.signal.addEventListener("abort", () => {
          clearInterval(interval);
          try {
            controller.close();
          } catch {
          }
        });
      },
    });

    return new Response(fallback, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
