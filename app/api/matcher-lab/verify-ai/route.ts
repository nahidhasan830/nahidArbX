import { NextRequest, NextResponse } from "next/server";
import { getById } from "@/lib/db/repositories/match-pairs";
import { matchSingle } from "@/lib/matching/ai-search-client";
import {
  clearAiVerificationJob,
  getAiVerificationJob,
  startAiVerificationJob,
} from "@/lib/matching/matcher-lab-ai-verification-jobs";
import { logger } from "@/lib/shared/logger";

const tag = "MatcherVerifyAi";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const job = getAiVerificationJob(url.searchParams.get("jobId"));
  return NextResponse.json({ job });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, engine, action } = body;

    if (action === "start-bulk") {
      const pairIds = Array.isArray(body.pairIds)
        ? body.pairIds.filter((value: unknown): value is string => {
            return typeof value === "string" && value.length > 0;
          })
        : [];

      if (pairIds.length === 0) {
        return NextResponse.json(
          { error: "pairIds[] is required" },
          { status: 400 },
        );
      }

      if (engine && engine !== "ai-search" && engine !== "deepseek") {
        return NextResponse.json(
          { error: "Event matching uses DeepSeek Flash only" },
          { status: 400 },
        );
      }

      const result = startAiVerificationJob({
        pairIds,
        engine: "ai-search",
        model: "flash",
      });

      return NextResponse.json(result, { status: result.reused ? 200 : 202 });
    }

    if (!id || typeof id !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid id" },
        { status: 400 },
      );
    }

    const pair = await getById(id);
    if (!pair) {
      return NextResponse.json({ error: "Pair not found" }, { status: 404 });
    }

    const eventA = {
      homeTeam: pair.eventAHomeTeam,
      awayTeam: pair.eventAAwayTeam,
      competition: pair.eventACompetition,
      startTime: pair.eventAStartTime,
    };

    const eventB = {
      homeTeam: pair.eventBHomeTeam,
      awayTeam: pair.eventBAwayTeam,
      competition: pair.eventBCompetition,
      startTime: pair.eventBStartTime,
    };

    if (engine && engine !== "ai-search" && engine !== "deepseek") {
      return NextResponse.json(
        { error: "Event matching uses DeepSeek Flash only" },
        { status: 400 },
      );
    }

    const verdict = await matchSingle(
      {
        home_team: eventA.homeTeam,
        away_team: eventA.awayTeam,
        competition: eventA.competition,
        start_time: eventA.startTime,
        provider: pair.eventAProvider,
      },
      {
        home_team: eventB.homeTeam,
        away_team: eventB.awayTeam,
        competition: eventB.competition,
        start_time: eventB.startTime,
        provider: pair.eventBProvider,
      },
    );

    if (!verdict) {
      return NextResponse.json(
        { error: "AI Search service unreachable" },
        { status: 503 },
      );
    }

    return NextResponse.json({
      result: {
        decision: verdict.decision,
        confidence: verdict.confidence,
        model: verdict.model,
        engine: "ai-search",
        reasoning: verdict.reasoning,
        sources: verdict.sources,
        searchQueriesUsed: verdict.searchQueriesUsed,
        diagnostics: verdict.diagnostics,
      },
    });
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const url = new URL(request.url);
  const cleared = clearAiVerificationJob(url.searchParams.get("jobId"));
  if (!cleared) {
    return NextResponse.json(
      { error: "Cannot clear a running AI verification job" },
      { status: 409 },
    );
  }
  return NextResponse.json({ success: true });
}
