/**
 * SSE streaming endpoint for ML batch processing.
 *
 * POST { pairIds?: string[] }
 *
 * Proxies to the ML server's /scheduler/run-now and streams back
 * a simplified progress response. The ML server does all scoring
 * in-process — this route just bridges the request.
 */

import { NextRequest } from "next/server";
import { logger } from "@/lib/shared/logger";
import { getIdToken } from "@/lib/matching/entities/matcher-client";
import { resolveMatcherRunWithAiSearch } from "@/lib/matching/matcher-lab-ai-resolver";

const tag = "MlStreamRoute";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const pairIds: string[] | undefined = Array.isArray(body.pairIds)
      ? body.pairIds
      : undefined;

    const matcherUrl = process.env.ENTITY_MATCHER_URL;
    if (!matcherUrl) {
      return new Response(
        JSON.stringify({ error: "ENTITY_MATCHER_URL not configured" }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        function send(event: Record<string, unknown>) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
          } catch {
            // Stream closed by client
          }
        }

        try {
          send({ type: "transitioning" });

          const token = await getIdToken();
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (token) headers.Authorization = `Bearer ${token}`;

          const res = await fetch(
            `${matcherUrl.replace(/\/$/, "")}/scheduler/run-now`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ pairIds }),
            },
          );

          if (!res.ok) {
            send({ type: "service_unreachable" });
            controller.close();
            return;
          }

          const result = await resolveMatcherRunWithAiSearch(await res.json());

          send({
            type: "batch_complete",
            processed:
              result.status === "already_running" ? -1 : result.processed ?? 0,
            merged: result.merged ?? 0,
            rejected: result.rejected ?? 0,
            escalated: result.escalated ?? 0,
            aiSearchAttempted: result.aiSearchAttempted ?? 0,
            aiSearchMerged: result.aiSearchMerged ?? 0,
            aiSearchRejected: result.aiSearchRejected ?? 0,
            durationMs: result.durationMs ?? 0,
          });
        } catch (err) {
          logger.error(tag, `Stream failed: ${(err as Error).message}`);
          send({ type: "service_unreachable" });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
