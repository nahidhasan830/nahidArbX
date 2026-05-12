/**
 * settleBatch — top-level settlement entry point.
 *
 * Given a list of value-bet row IDs:
 *   1. Dedupe to unique eventIds.
 *   2. Run the free waterfall to resolve each eventId's final score once.
 *   3. Apply deterministic `settleBet(row, score)` per bet.
 * Bets whose market isn't covered by the pure settler (or whose event
 * couldn't be resolved at any tier) are returned with outcome "pending"
 * and a reason the caller can use to decide whether to escalate.
 */

import { getBetsByIds } from "../db/repositories/bets";
import type { ValueBetRow } from "@/lib/bets-history/types";
import {
  resolveScores,
  type WaterfallTelemetry,
  type SettleEvent,
} from "./waterfall";
import { settleBet } from "./settle-bet";
import type { SettleResult } from "./types";
import type { Outcome } from "../bets-history/types";
import { clearCanonicalCache, preResolveTeams } from "./aliases";

export interface SettleBatchOptions {
  /**
   * Skip Tier 0 (DB cache) so the waterfall re-resolves events even when
   * an old score is cached. Useful for "Re-run default pipeline" in the UI.
   */
  bypassCache?: boolean;
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
  telemetry: WaterfallTelemetry & {
    settledDeterministically: number;
    unsupported: number;
    unresolvedEvents: number;
  };
}

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

  // Dedupe by eventId, keeping a single metadata copy per event. When the
  // same event appears on multiple bets the team/time fields are identical
  // by construction (denormalized at persist time), so the first row wins.
  const eventMap = new Map<string, SettleEvent>();
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
  }

  // ── Pre-resolve team names via entity DB ─────────────────────────────
  //
  // Before the waterfall fuzzy-matches our team names against score
  // sources, look up canonical names from the entity-resolution DB.
  // Every merge in Matcher Lab feeds this — if "Ypiranga FC" and
  // "Ypiranga-RS" share the same entity, both resolve to the canonical
  // name, guaranteeing a 1.0 similarity score.
  clearCanonicalCache();
  const allTeamNames = rows.flatMap((r) => [r.homeTeam, r.awayTeam]);
  await preResolveTeams(allTeamNames, { provider: "settle" });
  // Does the batch contain any corner-market bet? If so, ask the
  // waterfall to fetch corner stats. If not, skip the extra HTTP cost.
  const CORNER_MARKETS = new Set([
    "CORNERS", "HOME_CORNERS_TOTAL", "AWAY_CORNERS_TOTAL",
    "CORNERS_HANDICAP", "CORNERS_EUROPEAN_HANDICAP",
  ]);
  const BOOKING_MARKETS = new Set(["BOOKINGS", "BOOKINGS_HANDICAP"]);

  const needsCorners = rows.some((r) => CORNER_MARKETS.has(r.marketType));
  const needsBookings = rows.some((r) => BOOKING_MARKETS.has(r.marketType));

  // If any bet uses a non-FT scope, the waterfall MUST resolve HT scores.
  // Without this flag, Tier 0 happily accepts cached ESPN rows that lack
  // HT data — then settleBet() returns "pending" because it can't compute
  // the 1H/2H scope.
  const needsHtScore = rows.some(
    (r) => r.timeScope === "1H" || r.timeScope === "2H",
  );

  const { scores, telemetry } = await resolveScores([...eventMap.values()], {
    needsCorners,
    needsBookings,
    needsHtScore,
    bypassCache: options.bypassCache === true,
  });

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
    telemetry: {
      ...telemetry,
      settledDeterministically,
      unsupported,
      unresolvedEvents,
    },
  };
  return result;
}
