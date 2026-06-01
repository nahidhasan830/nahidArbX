import { NextRequest, NextResponse } from "next/server";
import {
  countDecisionRows,
  decisionCountsForDecisionRows,
  listDecisionRows,
  markManualDecision,
  runEventMatcher,
} from "@/lib/event-matcher";
import type { EventMatcherRunOptions } from "@/lib/event-matcher/types";
import { logger } from "@/lib/shared/logger";

const tag = "MatcherLab";

const DECISIONS = new Set(["auto_merge", "auto_reject", "human_review"]);
const MANUAL_DECISIONS = new Set(["auto_merge", "auto_reject", "human_review"]);

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId") || undefined;
    const decision = url.searchParams.get("decision") || undefined;
    const limit = parsePositiveInt(url.searchParams.get("limit"), 200, 500);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

    if (decision && !DECISIONS.has(decision)) {
      return NextResponse.json(
        { error: `Invalid decision: ${decision}` },
        { status: 400 },
      );
    }

    const query = {
      runId,
      decision,
      limit,
      offset,
    };
    const countQuery = {
      runId,
      decision,
    };
    const countByDecisionQuery = {
      runId,
    };

    const [rows, total, decisionCounts] = await Promise.all([
      listDecisionRows(query),
      countDecisionRows(countQuery),
      decisionCountsForDecisionRows(countByDecisionQuery),
    ]);

    return NextResponse.json({
      rows,
      runId,
      decision,
      limit,
      offset,
      total,
      decisionCounts,
    });
  } catch (err) {
    logger.error(tag, `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body?.action;

    switch (action) {
      case "run": {
        const decisionIds = Array.isArray(body.decisionIds)
          ? body.decisionIds.filter((id: unknown): id is string => {
              return typeof id === "string" && id.trim().length > 0;
            })
          : undefined;
        const options: EventMatcherRunOptions = {
          trigger: "manual",
          mode: "apply",
          applyMerges: true,
          decisionIds,
          useDeepSeek:
            typeof body.useDeepSeek === "boolean"
              ? body.useDeepSeek
              : undefined,
        };
        const summary = await runEventMatcher(options);
        logger.info(
          tag,
          `Event matcher run ${summary.id}: ${summary.status}, ${summary.candidateCount} candidates`,
        );
        return NextResponse.json(summary, {
          status: summary.status === "completed" ? 200 : 500,
        });
      }

      case "manual-decision": {
        const decisionId =
          typeof body.decisionId === "string" ? body.decisionId : "";
        const decision = typeof body.decision === "string" ? body.decision : "";
        const reason = typeof body.reason === "string" ? body.reason : null;

        if (!decisionId || !MANUAL_DECISIONS.has(decision)) {
          return NextResponse.json(
            { error: "decisionId and valid decision are required" },
            { status: 400 },
          );
        }

        const ok = await markManualDecision({
          decisionId,
          decision: decision as "auto_merge" | "auto_reject" | "human_review",
          reason,
        });
        if (!ok) {
          return NextResponse.json(
            { error: "Decision not found" },
            { status: 404 },
          );
        }

        logger.info(tag, `Manual decision ${decisionId}: ${decision}`);
        return NextResponse.json({ success: true });
      }

      case "manual-decisions": {
        const items = Array.isArray(body.items) ? body.items : [];
        if (items.length === 0) {
          return NextResponse.json(
            { error: "At least one decision is required" },
            { status: 400 },
          );
        }

        const results: Array<{ decisionId: string; success: boolean }> = [];
        for (const item of items) {
          const decisionId =
            typeof item?.decisionId === "string" ? item.decisionId : "";
          const decision =
            typeof item?.decision === "string" ? item.decision : "";
          const reason = typeof item?.reason === "string" ? item.reason : null;

          if (!decisionId || !MANUAL_DECISIONS.has(decision)) {
            return NextResponse.json(
              { error: "Every item needs a decisionId and valid decision" },
              { status: 400 },
            );
          }

          const success = await markManualDecision({
            decisionId,
            decision: decision as "auto_merge" | "auto_reject" | "human_review",
            reason,
          });
          results.push({ decisionId, success });
        }

        logger.info(tag, `Manual decisions saved: ${results.length}`);
        return NextResponse.json({ success: true, results });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${String(action)}` },
          { status: 400 },
        );
    }
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
