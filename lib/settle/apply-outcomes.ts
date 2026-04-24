import type { Outcome } from "../bets-history/types";
import {
  applySettlement,
  getBetsByIds,
  markOutcomesBulk,
  type ValueBetRow,
} from "../db/repositories/bets";
import { getBettingProvider } from "../betting/registry";
import { notify } from "../notifier";
import type { BetOutcome, MatchScoreInfo } from "../notifier/types";
import { logger } from "../shared/logger";

export interface SettlementOutcomeUpdate {
  id: string;
  outcome: Outcome;
  source?: string | null;
  score?: string | null;
}

const parseProposalScore = (
  score: string | null | undefined,
): MatchScoreInfo | null => {
  if (!score) return null;
  const parts = score.split("-").map(Number);
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  return { status: "FT", ftHome: parts[0], ftAway: parts[1] };
};

async function notifyPlacedSettlement(
  row: ValueBetRow,
  source: string | null,
  score: string | null | undefined,
): Promise<void> {
  const adapter = getBettingProvider(row.provider ?? "");
  await notify({
    type: "bet:settled",
    at: row.settledAt ?? new Date().toISOString(),
    provider: row.provider ?? "",
    providerDisplayName: adapter?.providerDisplayName ?? row.provider ?? "",
    eventName: `${row.homeTeam} vs ${row.awayTeam}`,
    competition: row.competition,
    marketName: row.marketType,
    selectionName: row.atomLabel ?? row.atomId,
    stake: Number(row.stake ?? 0),
    odds: Number(row.odds ?? 0),
    closingOdds: row.closingSoftOdds ? Number(row.closingSoftOdds) : null,
    placedAt: row.placedAt ?? null,
    currency: row.currency ?? "BDT",
    outcome: row.outcome as BetOutcome,
    pnl: Number(row.pnl ?? 0),
    settledBySource: source ?? undefined,
    matchScore: parseProposalScore(score) ?? undefined,
    timeScope: row.timeScope ?? null,
    familyLine: row.familyLine != null ? String(row.familyLine) : null,
  });
}

/**
 * Apply settlement outcomes across mixed placed/unplaced rows using the
 * unified bets table. Unplaced detections are marked silently; placed
 * bets go through applySettlement() so pnl/settledAt stay correct and
 * the normal settlement notification fires.
 */
export async function applySettlementOutcomes(
  updates: SettlementOutcomeUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;

  const rows = await getBetsByIds(updates.map((u) => u.id));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const unplacedUpdates = updates.filter((u) => {
    const row = rowById.get(u.id);
    return row && row.placedAt == null;
  });

  let applied = 0;
  if (unplacedUpdates.length > 0) {
    applied += await markOutcomesBulk(
      unplacedUpdates.map((u) => ({
        id: u.id,
        outcome: u.outcome,
        source: u.source ?? null,
      })),
    );
  }

  const placedUpdates = updates.filter((u) => {
    const row = rowById.get(u.id);
    return row && row.placedAt != null;
  });

  for (const update of placedUpdates) {
    if (update.outcome === "pending") continue;
    const settled = await applySettlement({
      betId: update.id,
      outcome: update.outcome,
      settledBySource: update.source ?? null,
    });
    if (!settled) continue;
    applied++;
    try {
      await notifyPlacedSettlement(
        settled,
        update.source ?? null,
        update.score,
      );
    } catch (err) {
      logger.warn(
        "SettlementApply",
        `Notification failed for ${update.id}: ${(err as Error).message}`,
      );
    }
  }

  return applied;
}
