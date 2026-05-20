/**
 * One-shot backfill: re-settle Asian-Handicap-style bets affected by the
 * away-side line-perspective bug fixed in lib/settle/settle-bet.ts.
 *
 * Before the fix, settleAhLeg used `away - home + line` for the away leg
 * with `line` taken straight from family.line (home perspective). For
 * any away-backed atom this produced a wrong sign, resulting in
 * incorrect won/lost/half-x/void outcomes when the actual margin was
 * close to the line. This script:
 *
 *   1. Pulls every away-side AH / CORNERS_HANDICAP / BOOKINGS_HANDICAP
 *      bet that has been settled (outcome != pending/cancelled) and has
 *      a cached match_scores row (status FT/AET/PEN).
 *   2. Re-runs settleBet on each with the cached score under the FIXED
 *      logic.
 *   3. For rows whose recomputed outcome differs from the stored one,
 *      accumulates updates and applies them via applySettlementOutcomes
 *      (handles placed vs unplaced rows + ML side effects).
 *
 * Dry-run by default. Pass --execute to actually write.
 *
 *   npx tsx scripts/resettle-away-handicap-fix.ts            # dry-run
 *   npx tsx scripts/resettle-away-handicap-fix.ts --execute  # apply
 */

import { ensureDbReady, db } from "../lib/db/client";
import { bets, matchScores } from "../lib/db/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { settleBet } from "../lib/settle/settle-bet";
import {
  applySettlementOutcomes,
  type SettlementOutcomeUpdate,
} from "../lib/settle/apply-outcomes";
import type { ValueBetRow, Outcome } from "../lib/bets-history/types";
import type { MatchScore } from "../lib/settle/types";

const EXECUTE = process.argv.includes("--execute");

const TARGET_MARKETS = [
  "ASIAN_HANDICAP",
  "CORNERS_HANDICAP",
  "BOOKINGS_HANDICAP",
] as const;

const FINAL_STATUSES = ["FT", "AET", "PEN"] as const;

interface DiffEntry {
  id: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  atomId: string;
  atomLabel: string;
  familyLine: number | null;
  storedOutcome: string;
  computedOutcome: Outcome;
  ftHome: number;
  ftAway: number;
  source: string;
}

async function main(): Promise<void> {
  await ensureDbReady();

  console.log(
    `[resettle-away-handicap] mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}`,
  );

  // 1. Pull all candidate bets joined with their cached score.
  //    Restrict to away-side handicap atoms (atom_id contains "_away_ah_"
  //    or "_bookings_away_ah_" for booking-points handicap).
  const candidateRows = await db
    .select({
      bet: bets,
      score: matchScores,
    })
    .from(bets)
    .innerJoin(matchScores, eq(matchScores.eventId, bets.eventId))
    .where(
      and(
        inArray(bets.marketType, TARGET_MARKETS as unknown as string[]),
        sql`${bets.atomId} LIKE '%\\_away\\_ah\\_%' ESCAPE '\\'`,
        ne(bets.outcome, "pending"),
        ne(bets.outcome, "cancelled"),
        inArray(matchScores.status, FINAL_STATUSES as unknown as string[]),
      ),
    );

  console.log(
    `[resettle-away-handicap] candidate rows: ${candidateRows.length}`,
  );

  // 2. Re-run settleBet on each and collect diffs.
  const diffs: DiffEntry[] = [];
  for (const { bet, score } of candidateRows) {
    const valueBetRow: ValueBetRow = {
      ...bet,
      familyLine: bet.familyLine == null ? null : Number(bet.familyLine),
    } as unknown as ValueBetRow;

    const matchScore: MatchScore = {
      eventId: score.eventId,
      status: score.status as MatchScore["status"],
      htHome: score.htHome,
      htAway: score.htAway,
      ftHome: score.ftHome,
      ftAway: score.ftAway,
      etHome: score.etHome ?? null,
      etAway: score.etAway ?? null,
      penHome: score.penHome ?? null,
      penAway: score.penAway ?? null,
      cornersHome: score.cornersHome ?? null,
      cornersAway: score.cornersAway ?? null,
      htCornersHome: score.htCornersHome ?? null,
      htCornersAway: score.htCornersAway ?? null,
      bookingsHome: score.bookingsHome ?? null,
      bookingsAway: score.bookingsAway ?? null,
      source: score.source as MatchScore["source"],
      confidence: Number(score.confidence),
      sourceUrl: score.sourceUrl ?? null,
      fetchedAt: score.fetchedAt,
    };

    const result = settleBet(valueBetRow, matchScore);

    // Skip pending (e.g. CORNERS_HANDICAP without corners enrichment) and
    // void (when settle-bet itself decided void) — those are not settlement
    // mistakes we should overwrite for paper-traded rows that already have
    // a stored outcome. We still flag them in the diff log for visibility
    // but only collect actionable changes (concrete won/lost/half_*).
    if (
      result.outcome === "pending" ||
      result.reason === "unsupported-market" ||
      result.reason === "missing-ht-score"
    ) {
      continue;
    }

    if (result.outcome !== bet.outcome) {
      diffs.push({
        id: bet.id,
        eventId: bet.eventId,
        homeTeam: bet.homeTeam,
        awayTeam: bet.awayTeam,
        marketType: bet.marketType,
        atomId: bet.atomId,
        atomLabel: bet.atomLabel,
        familyLine: bet.familyLine == null ? null : Number(bet.familyLine),
        storedOutcome: bet.outcome,
        computedOutcome: result.outcome,
        ftHome: score.ftHome,
        ftAway: score.ftAway,
        source: score.source,
      });
    }
  }

  console.log(
    `[resettle-away-handicap] outcomes that change under fixed logic: ${diffs.length}`,
  );

  // 3. Distribution before vs after.
  const beforeDist: Record<string, number> = {};
  const afterDist: Record<string, number> = {};
  for (const d of diffs) {
    beforeDist[d.storedOutcome] = (beforeDist[d.storedOutcome] ?? 0) + 1;
    afterDist[d.computedOutcome] = (afterDist[d.computedOutcome] ?? 0) + 1;
  }
  console.log("\n[resettle-away-handicap] outcome shifts:");
  console.log("  Before →", beforeDist);
  console.log("  After  →", afterDist);

  // Show a small sample so the operator can spot-check before applying.
  const sample = diffs.slice(0, 5);
  if (sample.length > 0) {
    console.log("\n[resettle-away-handicap] sample diffs (first 5):");
    for (const d of sample) {
      console.log(
        `  ${d.atomLabel.padEnd(12)} on ${d.ftHome}-${d.ftAway} ` +
          `${d.storedOutcome} → ${d.computedOutcome} ` +
          `[${d.source}] ${d.homeTeam} vs ${d.awayTeam}`,
      );
    }
  }

  if (!EXECUTE) {
    console.log(
      "\n[resettle-away-handicap] DRY-RUN — no writes. " +
        "Re-run with --execute to apply.",
    );
    return;
  }

  if (diffs.length === 0) {
    console.log("\n[resettle-away-handicap] nothing to do.");
    return;
  }

  // 4. Apply via applySettlementOutcomes — handles placed vs unplaced and
  //    ML training data hooks.
  const updates: SettlementOutcomeUpdate[] = diffs.map((d) => ({
    id: d.id,
    outcome: d.computedOutcome,
    source: `${d.source}+ah-fix-2026-05`,
    score: `${d.ftHome}-${d.ftAway}`,
  }));

  console.log(
    `\n[resettle-away-handicap] applying ${updates.length} updates ` +
      `via applySettlementOutcomes...`,
  );
  const applied = await applySettlementOutcomes(updates);
  console.log(`[resettle-away-handicap] applied: ${applied}`);

  // 5. Verify the canonical Bogota vs Real Cartagena bets specifically —
  //    these are the bets the operator first reported.
  const bogotaIds = [
    "matched-ninewickets-sportsbook-35614075-pinnacle-1630520127|ft_ah_p1_25|ft_away_ah_m1_25",
    "matched-ninewickets-sportsbook-35614075-pinnacle-1630520127|ft_ah_p1|ft_away_ah_m1",
  ];
  const verify = await db
    .select({
      id: bets.id,
      atomLabel: bets.atomLabel,
      outcome: bets.outcome,
      settledBySource: bets.settledBySource,
    })
    .from(bets)
    .where(inArray(bets.id, bogotaIds));
  console.log("\n[resettle-away-handicap] Bogota vs Real Cartagena (1-2):");
  for (const r of verify) {
    console.log(
      `  ${r.atomLabel.padEnd(12)} → ${r.outcome.padEnd(10)} [${r.settledBySource}]`,
    );
  }
}

main()
  .then(() => {
    console.log("\n[resettle-away-handicap] done.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[resettle-away-handicap] FAILED:", err);
    process.exit(1);
  });
