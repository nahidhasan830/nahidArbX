import { NextRequest, NextResponse } from "next/server";
import { getById } from "@/lib/db/repositories/match-pairs";
import { analyzeMatchWithGemini } from "@/lib/ai/gemini";
import { matchSingle } from "@/lib/matching/ai-search-client";
import { logger } from "@/lib/shared/logger";

const tag = "MatcherVerifyAi";

export async function POST(request: NextRequest) {
  try {
    const { id, model, engine } = await request.json();

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

    // AI Search (Groq/HF + web grounding) or Gemini (paid, no grounding)
    // Both "ai-search" and "huggingface" go through the grounded pipeline;
    // "huggingface" pins the LLM to the HF Router engine specifically.
    if (engine === "ai-search" || engine === "huggingface") {
      const llmProvider = engine === "huggingface" ? "huggingface" : undefined;
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
        { llmProvider },
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
          engine,
          reasoning: verdict.reasoning,
          sources: verdict.sources,
          search_queries_used: verdict.search_queries_used,
        },
      });
    }

    // Default: Gemini
    const result = await analyzeMatchWithGemini(eventA, eventB, { model });

    return NextResponse.json({
      result: { ...result, engine: "gemini" },
    });
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
