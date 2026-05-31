import { NextRequest } from "next/server";
import { runEventMatcher } from "@/lib/event-matcher";
import type { EventMatcherRunOptions } from "@/lib/event-matcher/types";
import { logger } from "@/lib/shared/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function writeEvent(
  controller: ReadableStreamDefaultController,
  data: unknown,
) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const decisionIds = Array.isArray(body.decisionIds)
    ? body.decisionIds.filter((id: unknown): id is string => {
        return typeof id === "string" && id.trim().length > 0;
      })
    : undefined;
  const options: Omit<EventMatcherRunOptions, "onProgress"> = {
    trigger: "manual",
    mode: "apply",
    decisionIds,
    useDeepSeek:
      typeof body.useDeepSeek === "boolean" ? body.useDeepSeek : undefined,
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const summary = await runEventMatcher({
          ...options,
          onProgress: (event) => writeEvent(controller, event),
        });
        logger.info(
          "MatcherLabStream",
          `Event matcher run ${summary.id}: ${summary.status}, ${summary.candidateCount} candidates`,
        );
      } catch (err) {
        writeEvent(controller, {
          runId: "unknown",
          mode: "apply",
          phase: "failed",
          message: "Matcher stream failed before run completion",
          timestamp: new Date().toISOString(),
          elapsedMs: 0,
          counters: {
            snapshots: 0,
            generatedCandidates: 0,
            candidatesToScore: 0,
            skippedCandidates: 0,
            scoredCandidates: 0,
            insertedCandidates: 0,
            autoMerged: 0,
            autoRejected: 0,
            deepseekReviewed: 0,
            humanReview: 0,
          },
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        logger.error(
          "MatcherLabStream",
          `POST failed: ${(err as Error).message}`,
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
