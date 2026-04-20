/**
 * SSE endpoint for live bulk-run updates.
 *
 * Any client can subscribe at any time — including after a page refresh mid-
 * run. The handler replays the recent event buffer so the reconnecting client
 * rehydrates its log/progress, then tails live events as they arrive.
 */

import {
  getBuffer,
  getStatus,
  subscribe,
  type BulkEvent,
} from "@/lib/matching/bulk-control";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (evt: BulkEvent | { type: "snapshot"; status: unknown }) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(
              `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`,
            ),
          );
        } catch {
          closed = true;
        }
      };

      // First frame: current session snapshot so late subscribers know
      // whether a run is active, how far along, which provider, etc.
      send({ type: "snapshot", status: getStatus() });

      // Replay buffered events for log/result catch-up.
      for (const evt of getBuffer()) {
        send(evt);
      }

      // Hydration boundary: everything above this frame is a historical
      // replay, everything below is live. The client uses this marker to
      // suppress user-facing notifications (toasts) for replayed `done`
      // events — those would otherwise fire every time the panel remounts
      // (tab switch, navigation) since the server keeps the buffer across
      // the session.
      send({ type: "hydrated" });

      // Tail new events.
      const unsubscribe = subscribe((evt) => send(evt));

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed — safe.
        }
      };

      // Drop the subscription when the client disconnects.
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
