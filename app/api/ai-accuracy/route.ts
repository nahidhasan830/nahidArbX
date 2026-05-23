import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listByStage,
  type MatchPairRow,
} from "@/lib/db/repositories/match-pairs";
import { buildMatchQueries } from "@/lib/ai/grounding";
import type { EventInfo } from "@/lib/ai/search/types";

const DEFAULT_SAMPLE_SIZE = 20;
const MAX_SAMPLE_SIZE = 50;
const DEFAULT_POOL_SIZE = 500;
const MAX_POOL_SIZE = 2000;

const QuerySchema = z.object({
  kind: z.literal("event-match"),
  sampleSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SAMPLE_SIZE)
    .default(DEFAULT_SAMPLE_SIZE),
  poolSize: z.coerce
    .number()
    .int()
    .min(20)
    .max(MAX_POOL_SIZE)
    .default(DEFAULT_POOL_SIZE),
});

export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = QuerySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid query parameters" },
      { status: 400 },
    );
  }

  const samples = await buildEventMatchSamples(
    parsed.data.sampleSize,
    parsed.data.poolSize,
  );
  return NextResponse.json({
    kind: parsed.data.kind,
    requested: parsed.data.sampleSize,
    count: samples.length,
    samples,
  });
}

async function buildEventMatchSamples(sampleSize: number, poolSize: number) {
  const rows = await listByStage("history", { limit: poolSize });
  const decided = rows
    .map((row) => ({ row, expected: expectedMatchVerdict(row.decision) }))
    .filter(
      (item): item is { row: MatchPairRow; expected: "SAME" | "DIFFERENT" } =>
        item.expected !== null,
    )
    .filter((item) => item.expected === "SAME");

  const human = shuffle(
    decided.filter((item) => item.row.decidedBy === "human"),
  );
  const other = shuffle(
    decided.filter((item) => item.row.decidedBy !== "human"),
  );

  return [...human, ...other].slice(0, sampleSize).map(({ row, expected }) => {
    const eventA = matchPairEventA(row);
    const eventB = matchPairEventB(row);
    const request = {
      endpoint: "/api/matcher-lab/verify-ai",
      body: { id: row.id, engine: "ai-search" },
      searchQueries: buildMatchQueries(eventA, eventB),
    };

    return {
      id: row.id,
      expected,
      decision: row.decision,
      decidedBy: row.decidedBy,
      stringScore: row.stringScore,
      eventA,
      eventB,
      request,
    };
  });
}

function matchPairEventA(row: MatchPairRow): EventInfo {
  return {
    homeTeam: row.eventAHomeTeam,
    awayTeam: row.eventAAwayTeam,
    competition: row.eventACompetition,
    startTime: row.eventAStartTime,
    provider: row.eventAProvider,
  };
}

function matchPairEventB(row: MatchPairRow): EventInfo {
  return {
    homeTeam: row.eventBHomeTeam,
    awayTeam: row.eventBAwayTeam,
    competition: row.eventBCompetition,
    startTime: row.eventBStartTime,
    provider: row.eventBProvider,
  };
}

function expectedMatchVerdict(
  decision: string | null,
): "SAME" | "DIFFERENT" | null {
  if (
    decision === "ai-merge" ||
    decision === "human-merge" ||
    decision === "auto-merge"
  ) {
    return "SAME";
  }
  if (
    decision === "ai-reject" ||
    decision === "human-reject" ||
    decision === "auto-reject"
  ) {
    return "DIFFERENT";
  }
  return null;
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
