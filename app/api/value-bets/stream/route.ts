/**
 * Dashboard SSE Streaming Endpoint
 *
 * Pushes real-time updates to connected browsers via Server-Sent Events.
 * Replaces polling — browsers only fetch data when something actually changes.
 *
 * Events emitted:
 * - connected: Initial handshake with server version
 * - sync:phase: Pipeline phase changes (fixtures, matching, markets, value detection)
 * - sync:complete: Odds sync finished (browser should refresh data)
 * - fixtures:complete: Fixture sync finished
 * - value:change: Value bets changed
 * - heartbeat: Keep-alive (every 30s)
 */

import { syncBus, type BusEvent } from "@/lib/events/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const connectionId = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      function send(event: string, data: unknown, id?: number) {
        try {
          let msg = "";
          if (id !== undefined) msg += `id: ${id}\n`;
          msg += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(msg));
        } catch {
          // Controller closed
        }
      }

      // Set retry interval for auto-reconnect (5 seconds)
      controller.enqueue(encoder.encode("retry: 5000\n\n"));

      // Send initial handshake
      send(
        "connected",
        {
          connectionId,
          version: syncBus.version,
          serverTime: Date.now(),
        },
        syncBus.version,
      );

      // Subscribe to the global event bus
      const unsubscribe = syncBus.subscribeWithId(
        connectionId,
        (event: BusEvent) => {
          if (event.type === "data:delta") {
            // Send delta/full-refresh as a dedicated event type
            send("data:delta", event.delta, syncBus.version);
          } else {
            send(event.type, event, syncBus.version);
          }
        },
      );

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        send("heartbeat", {
          time: Date.now(),
          version: syncBus.version,
          clients: syncBus.clientCount,
        });
      }, 30_000);

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Already closed
        }
      });
    },
  });

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
