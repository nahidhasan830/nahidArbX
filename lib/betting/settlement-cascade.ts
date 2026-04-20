/**
 * Cascade a value_bet settlement onto its placed_bets rows.
 *
 * Called from `markOutcomesBulk` in the value-bets repo. For every
 * settled value_bet:
 *   1. Find placed_bets rows with the same value_bet_id (lifetime dedup
 *      guarantees at most one)
 *   2. Mirror the outcome, compute P&L, snapshot CLV from
 *      value_bets.closing_soft_odds
 *   3. Fire a `bet:settled` notification through the generic notifier
 *
 * Kept separate from the value-bets repository to:
 *   - Avoid repo → placer import cycles
 *   - Let the reusable settlement pipeline stay notification-agnostic
 */
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { valueBets } from "@/lib/db/schema";
import {
  applySettlementToPlaced,
  findPlacedByValueBetIds,
} from "@/lib/db/repositories/placed-bets";
import type { PlacedBetStatus } from "@/lib/db/repositories/placed-bets";
import { BETTING_PROVIDERS } from "./registry";
import { notify } from "@/lib/notifier";
import type { MatchScoreInfo } from "@/lib/notifier/types";
import { logger } from "@/lib/shared/logger";
import { buildBetGradeUrl } from "@/lib/shared/google-ai-link";
import { getScoresByEventIds } from "@/lib/db/repositories/match-scores";

type NormalizedOutcome =
  | "pending"
  | "won"
  | "lost"
  | "void"
  | "half_won"
  | "half_lost";

export interface SettleUpdate {
  id: string;
  outcome: NormalizedOutcome;
  source: string | null;
}

export async function cascadePlacedBetSettlements(
  updates: SettleUpdate[],
): Promise<void> {
  const terminal = updates.filter((u) => u.outcome !== "pending");
  if (terminal.length === 0) return;

  const placedRows = await findPlacedByValueBetIds(terminal.map((u) => u.id));
  if (placedRows.length === 0) return;

  // One query for closing_soft_odds on all relevant value_bets — lets us
  // snapshot CLV onto placed_bets without a per-row DB roundtrip.
  const closingSnaps = new Map<string, number | null>();
  const vbs = await db
    .select({
      id: valueBets.id,
      closingSoftOdds: valueBets.closingSoftOdds,
      timeScope: valueBets.timeScope,
      familyLine: valueBets.familyLine,
    })
    .from(valueBets)
    .where(
      inArray(
        valueBets.id,
        terminal.map((u) => u.id),
      ),
    );
  for (const row of vbs) {
    closingSnaps.set(
      row.id,
      row.closingSoftOdds === null ? null : Number(row.closingSoftOdds),
    );
  }

  const updateByVbId = new Map(terminal.map((u) => [u.id, u]));

  // Batch-fetch final scores for every event we're about to notify on.
  // One roundtrip, map-indexed — avoids N queries inside the per-bet
  // loop and keeps the cascade cheap when big bulk updates land.
  const eventIds = Array.from(
    new Set(placedRows.map((p) => p.eventId).filter(Boolean)),
  );
  let scoresByEventId: Awaited<ReturnType<typeof getScoresByEventIds>> =
    new Map();
  try {
    scoresByEventId = await getScoresByEventIds(eventIds);
  } catch (err) {
    logger.warn(
      "SettlementCascade",
      `score lookup failed (${err instanceof Error ? err.message : String(err)}); notifications will omit final score`,
    );
  }

  for (const placed of placedRows) {
    if (!placed.valueBetId) continue;
    const update = updateByVbId.get(placed.valueBetId);
    if (!update) continue;
    if (update.outcome === "pending") continue;

    const outcome: Exclude<PlacedBetStatus, "pending" | "cancelled"> =
      update.outcome;

    const settled = await applySettlementToPlaced({
      placedBetId: placed.id,
      outcome,
      settledBySource: update.source,
      closingOdds: closingSnaps.get(placed.valueBetId) ?? null,
      closingSharpOdds: null,
    });
    if (!settled) continue;

    const adapter = BETTING_PROVIDERS[settled.provider];
    try {
      const [homeTeam, awayTeam] = settled.eventName.split(" vs ");
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
      const score = scoresByEventId.get(settled.eventId);
      const matchScore: MatchScoreInfo | null = score
        ? {
            status: score.status,
            ftHome: score.ftHome,
            ftAway: score.ftAway,
            htHome: score.htHome,
            htAway: score.htAway,
            etHome: score.etHome ?? null,
            etAway: score.etAway ?? null,
            penHome: score.penHome ?? null,
            penAway: score.penAway ?? null,
          }
        : null;
      // Pull time-scope + family-line from the source value_bet row so
      // the notifier can render e.g. "1st Half · Over 2.5" without
      // reparsing the market string.
      const vbExtras = vbs.find((v) => v.id === placed.valueBetId) ?? null;
      await notify({
        type: "bet:settled",
        at: settled.settledAt ?? new Date().toISOString(),
        provider: settled.provider,
        providerDisplayName: adapter?.providerDisplayName ?? settled.provider,
        eventName: settled.eventName,
        competition: settled.competition,
        marketName: settled.marketType,
        selectionName: settled.atomLabel,
        stake: Number(settled.stake),
        odds: Number(settled.odds),
        closingOdds:
          settled.closingOdds !== null && settled.closingOdds !== undefined
            ? Number(settled.closingOdds)
            : null,
        placedAt: settled.placedAt,
        currency: settled.currency,
        outcome,
        pnl: Number(settled.pnl ?? 0),
        settledBySource: settled.settledBySource ?? undefined,
        matchScore,
        timeScope: vbExtras?.timeScope ?? null,
        familyLine:
          vbExtras?.familyLine !== null && vbExtras?.familyLine !== undefined
            ? String(vbExtras.familyLine)
            : null,
        gradeUrl: buildBetGradeUrl({
          homeTeam: homeTeam ?? settled.eventName,
          awayTeam: awayTeam ?? "",
          competition: settled.competition,
          eventStartTime: settled.eventStartTime,
          marketType: settled.marketType,
          atomLabel: settled.atomLabel,
        }),
        dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
      });
    } catch (err) {
      logger.error(
        "SettlementCascade",
        `notify failed for placed=${settled.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// Re-export eq so anybody else wanting to extend can use it without a
// separate drizzle import.
export { eq };
