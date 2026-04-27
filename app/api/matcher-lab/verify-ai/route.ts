import { NextRequest, NextResponse } from "next/server";
import { getById } from "@/lib/db/repositories/match-pairs";
import { analyzeMatchWithGemini } from "@/lib/ai/gemini";
import { logger } from "@/lib/shared/logger";

const tag = "MatcherVerifyAi";

export async function POST(request: NextRequest) {
  try {
    const { id, model } = await request.json();

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

    const result = await analyzeMatchWithGemini(eventA, eventB, { model });

    return NextResponse.json({ result });
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
