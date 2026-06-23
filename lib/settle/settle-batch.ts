
import { getBetsByIds } from "../db/repositories/bets";
import type { ValueBetRow } from "@/lib/bets-history/types";
import {
  resolveScores,
  type WaterfallTelemetry,
  type SettleEvent,
  type SettlementDataRequirements,
} from "./waterfall";
import { settleBet } from "./settle-bet";
import type { SettleResult } from "./types";
import type { Outcome } from "../bets-history/types";
import { clearCanonicalCache, preResolveTeams } from "./aliases";

export interface SettleBatchOptions {
  bypassCache?: boolean;
  networkEventIds?: Set<string>;
}

export interface SettleProposal {
  id: string;
  proposedOutcome: Outcome;
  confidence: number;
  reasoning: string;
  score: string;
  tier: "pure" | "unresolved";
  source: string | null;
}

export interface SettleBatchResult {
  proposals: SettleProposal[];
  missing: string[];
  eventBreakdown: {
    networkAttemptedEventIds: string[];
    skippedByBackoffEventIds: string[];
    fullyResolvedEventIds: string[];
    stillUnresolvedEventIds: string[];
  };
  telemetry: WaterfallTelemetry & {
    settledDeterministically: number;
    unsupported: number;
    unresolvedEvents: number;
  };
}

const CORNER_MARKETS = new Set([
  "CORNERS",
  "HOME_CORNERS_TOTAL",
  "AWAY_CORNERS_TOTAL",
  "CORNERS_HANDICAP",
  "CORNERS_EUROPEAN_HANDICAP",
]);
const BOOKING_MARKETS = new Set(["BOOKINGS", "BOOKINGS_HANDICAP"]);

const buildProposal = (
  row: ValueBetRow,
  r: SettleResult,
  source: string | null,
): SettleProposal => ({
  id: row.id,
  proposedOutcome: r.outcome,
  confidence: r.confidence,
  reasoning: r.reasoning,
  score: r.scopeScore,
  tier: r.outcome === "pending" ? "unresolved" : "pure",
  source,
});

export async function settleBatch(
  ids: string[],
  options: SettleBatchOptions = {},
): Promise<SettleBatchResult> {
  const rows = await getBetsByIds(ids);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));

  const eventMap = new Map<string, SettleEvent>();
  const eventRequirements = new Map<string, SettlementDataRequirements>();
  for (const r of rows) {
    if (!eventMap.has(r.eventId)) {
      eventMap.set(r.eventId, {
        eventId: r.eventId,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        competition: r.competition,
        startTime: r.eventStartTime,
      });
    }
    const req = eventRequirements.get(r.eventId) ?? {};
    if (CORNER_MARKETS.has(r.marketType)) req.needsCorners = true;
    if (BOOKING_MARKETS.has(r.marketType)) req.needsBookings = true;
    if (r.timeScope === "1H" || r.timeScope === "2H") {
      req.needsHtScore = true;
    }
    eventRequirements.set(r.eventId, req);
  }

  clearCanonicalCache();
  const allTeamNames = rows.flatMap((r) => [r.homeTeam, r.awayTeam]);
  await preResolveTeams(allTeamNames, { provider: "settle" });
  const needsCorners = rows.some((r) => CORNER_MARKETS.has(r.marketType));
  const needsBookings = rows.some((r) => BOOKING_MARKETS.has(r.marketType));

  const needsHtScore = rows.some(
    (r) => r.timeScope === "1H" || r.timeScope === "2H",
  );

  const { scores, telemetry, eventBreakdown } = await resolveScores(
    [...eventMap.values()],
    {
      needsCorners,
      needsBookings,
      needsHtScore,
      bypassCache: options.bypassCache === true,
      eventRequirements,
      networkEventIds: options.networkEventIds,
    },
  );

  let settledDeterministically = 0;
  let unsupported = 0;

  const proposals: SettleProposal[] = rows.map((row) => {
    const score = scores.get(row.eventId);
    if (!score) {
      return {
        id: row.id,
        proposedOutcome: "pending",
        confidence: 0,
        reasoning: "No final score resolved by any tier.",
        score: "",
        tier: "unresolved",
        source: null,
      };
    }
    const res = settleBet(row, score);
    if (res.outcome !== "pending") settledDeterministically++;
    else unsupported++;
    return buildProposal(row, res, score.source);
  });

  const unresolvedEvents = telemetry.unresolved;

  const result: SettleBatchResult = {
    proposals,
    missing,
    eventBreakdown,
    telemetry: {
      ...telemetry,
      settledDeterministically,
      unsupported,
      unresolvedEvents,
    },
  };
  return result;
}
