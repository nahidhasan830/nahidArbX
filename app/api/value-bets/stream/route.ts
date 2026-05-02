/**
 * Dashboard SSE Streaming Endpoint — Proxy to Engine
 *
 * Proxies the SSE stream from the engine process (port 3001)
 * where the syncBus event emitter lives.
 */

import { engineSSEProxy } from "@/lib/engine-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const stream = engineSSEProxy();

  if (!stream) {
    // Engine unreachable — return a minimal SSE with error
    const encoder = new TextEncoder();
    const fallback = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: "Engine unreachable" })}\n\n`,
          ),
        );
        // Keep alive with periodic pings until client disconnects
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
          try { controller.close(); } catch { /* already closed */ }
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
