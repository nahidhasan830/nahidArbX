import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  listByStage,
  type MatchPairRow,
} from "@/lib/db/repositories/match-pairs";
import {
  getBetById,
  listBets,
} from "@/lib/db/repositories/bets";
import type { BetRow } from "@/lib/db/schema";
import { getScoresByEventIds } from "@/lib/db/repositories/match-scores";
import { settleBet } from "@/lib/settle/settle-bet";
import type { MatchScore } from "@/lib/settle/types";
import { normalizeOutcome, type ValueBetRow } from "@/lib/bets-history/types";
import {
  buildMatchQueries,
  buildSettlementQueries,
} from "@/lib/ai/grounding";
import type { EventInfo } from "@/lib/ai/search/types";

const DEFAULT_SAMPLE_SIZE = 20;
const MAX_SAMPLE_SIZE = 50;
const DEFAULT_POOL_SIZE = 500;
const MAX_POOL_SIZE = 2000;

const FT_GOAL_MARKETS = new Set([
  "MATCH_RESULT",
  "OVER_UNDER",
  "TOTAL_GOALS",
  "ASIAN_HANDICAP",
  "BTTS",
  "DNB",
  "HOME_TEAM_TOTAL",
  "AWAY_TEAM_TOTAL",
  "DOUBLE_CHANCE",
  "EUROPEAN_HANDICAP",
]);

const QuerySchema = z.object({
  kind: z.enum(["event-match", "settlement"]),
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

const SettlementOutcomeSchema = z.object({
  action: z.literal("settlement-outcome"),
  betId: z.string().min(1),
  score: z.object({
    ftHome: z.number().int().min(0).max(30),
    ftAway: z.number().int().min(0).max(30),
    htHome: z.number().int().min(0).max(30).nullable().optional(),
    htAway: z.number().int().min(0).max(30).nullable().optional(),
  }),
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

  if (parsed.data.kind === "event-match") {
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

  const samples = await buildSettlementSamples(
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

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = SettlementOutcomeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const bet = await getBetById(parsed.data.betId);
  if (!bet) {
    return NextResponse.json({ error: "Bet not found" }, { status: 404 });
  }

  const score: MatchScore = {
    eventId: bet.eventId,
    status: "FT",
    htHome: parsed.data.score.htHome ?? null,
    htAway: parsed.data.score.htAway ?? null,
    ftHome: parsed.data.score.ftHome,
    ftAway: parsed.data.score.ftAway,
    source: "manual",
    confidence: 1,
  };

  const result = settleBet(bet as ValueBetRow, score);
  return NextResponse.json({
    betId: bet.id,
    outcome: result.outcome,
    scopeScore: result.scopeScore,
    confidence: result.confidence,
    reasoning: result.reasoning,
    reason: result.reason,
  });
}

async function buildEventMatchSamples(sampleSize: number, poolSize: number) {
  const rows = await listByStage("history", { limit: poolSize });
  const decided = rows
    .map((row) => ({ row, expected: expectedMatchVerdict(row.decision) }))
    .filter((item): item is { row: MatchPairRow; expected: "SAME" | "DIFFERENT" } =>
      item.expected !== null,
    )
    .filter((item) => item.expected === "SAME");

  const human = shuffle(decided.filter((item) => item.row.decidedBy === "human"));
  const other = shuffle(decided.filter((item) => item.row.decidedBy !== "human"));

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

async function buildSettlementSamples(sampleSize: number, poolSize: number) {
  const { rows } = await listBets({ outcome: "settled", limit: poolSize });
  const scores = await getScoresByEventIds([...new Set(rows.map((r) => r.eventId))]);
  const eligible: Array<{
    bet: BetRow;
    score: MatchScore;
    expectedOutcome: string;
    request: {
      endpoint: string;
      body: {
        event: {
          home_team: string;
          away_team: string;
          competition: string;
          start_time: string;
        };
        question: string;
      };
      searchQueries: string[];
    };
  }> = [];

  for (const bet of rows) {
    if (bet.timeScope !== "FT") continue;
    if (!FT_GOAL_MARKETS.has(bet.marketType)) continue;

    const score = scores.get(bet.eventId);
    if (!score || score.status === "ABD" || score.status === "POSTPONED") continue;

    const settled = settleBet(bet as ValueBetRow, score);
    if (settled.outcome === "pending") continue;
    if (settled.outcome !== normalizeOutcome(bet.outcome)) continue;

    const event = {
      home_team: bet.homeTeam,
      away_team: bet.awayTeam,
      competition: bet.competition ?? "",
      start_time: bet.eventStartTime,
    };
    const eventInfo: EventInfo = {
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      competition: event.competition,
      startTime: event.start_time,
    };
    const dateStr = event.start_time.slice(0, 10);
    const question =
      `What was the full-time score of ${event.home_team} vs ${event.away_team}` +
      (event.competition ? ` in ${event.competition}` : "") +
      ` on ${dateStr}? Report the 90-minute score as HOME-AWAY.`;

    eligible.push({
      bet,
      score,
      expectedOutcome: settled.outcome,
      request: {
        endpoint: "/api/ai-search/verify-settlement",
        body: { event, question },
        searchQueries: buildSettlementQueries(eventInfo),
      },
    });
  }

  const uniqueByEvent: typeof eligible = [];
  const seenEvents = new Set<string>();
  for (const item of shuffle(eligible)) {
    if (seenEvents.has(item.bet.eventId)) continue;
    seenEvents.add(item.bet.eventId);
    uniqueByEvent.push(item);
    if (uniqueByEvent.length >= sampleSize) break;
  }

  return uniqueByEvent
    .map(({ bet, score, expectedOutcome, request }) => ({
      id: bet.id,
      eventId: bet.eventId,
      match: {
        homeTeam: bet.homeTeam,
        awayTeam: bet.awayTeam,
        competition: bet.competition,
        startTime: bet.eventStartTime,
      },
      market: {
        marketType: bet.marketType,
        timeScope: bet.timeScope,
        familyLine: bet.familyLine,
        atomId: bet.atomId,
        atomLabel: bet.atomLabel,
      },
      expectedOutcome,
      actualOutcome: normalizeOutcome(bet.outcome),
      actualScore: {
        ftHome: score.ftHome,
        ftAway: score.ftAway,
        htHome: score.htHome,
        htAway: score.htAway,
        source: score.source,
        confidence: score.confidence,
      },
      request,
    }));
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

function expectedMatchVerdict(decision: string | null): "SAME" | "DIFFERENT" | null {
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
