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
import {
  writeSettledExamples,
  resolveDetectionSnapshot,
} from "../ml/training-example-writer";
import type { BetRow } from "../db/schema";
import { attachSettlementOutcomes } from "../db/repositories/ml-prediction-audit";

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

  // Best-effort balance fetch — don't let it block the notification.
  let balance: number | undefined;
  if (adapter) {
    try {
      const info = await adapter.getAccountInfo();
      balance = info.balance;
    } catch {
      // Swallow — balance is a nice-to-have, not critical.
    }
  }

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

    placedAt: row.placedAt ?? null,
    currency: row.currency ?? "BDT",
    outcome: row.outcome as BetOutcome,
    pnl: Number(row.pnl ?? 0),
    settledBySource: source ?? undefined,
    matchScore: parseProposalScore(score) ?? undefined,
    timeScope: row.timeScope ?? null,
    familyLine: row.familyLine != null ? String(row.familyLine) : null,
    balance,
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

  // ── ML training data hooks ───────────────────────────────────────
  // After settlement outcomes are applied, write training examples and
  // resolve shadow-scored detection snapshots. Fire-and-forget to never
  // block the settlement pipeline.
  if (applied > 0) {
    // Re-fetch rows with updated outcomes for training example creation
    const settledIds = updates
      .filter((u) => u.outcome !== "pending")
      .map((u) => u.id);
    if (settledIds.length > 0) {
      getBetsByIds(settledIds)
        .then(async (settledRows) => {
          // 1. Write settled training examples from bets with features
          try {
            await writeSettledExamples(settledRows as BetRow[]);
          } catch (err) {
            logger.warn(
              "SettlementApply",
              `writeSettledExamples failed: ${(err as Error).message}`,
            );
          }

          // 2. Resolve shadow-scored detection snapshots
          for (const row of settledRows) {
            if (row.outcome === "pending" || row.outcome === "void") continue;
            try {
              await resolveDetectionSnapshot(
                row.id,
                row.outcome,
                Number(row.softOdds ?? row.odds ?? 0),
                Number(row.softCommissionPct ?? 0),
                row.pnl ?? null,
                row.clvPct ?? null,
                row.settledAt ?? null,
              );
            } catch {
              // Non-critical — swallow
            }
          }

          // 3. Mirror settlement onto ML prediction snapshots for visualization.
          try {
            await attachSettlementOutcomes(
              settledRows
                .filter((row) => row.outcome !== "pending")
                .map((row) => ({
                  betId: row.id,
                  outcome: row.outcome,
                  pnl: row.pnl ?? null,
                  clvPct: row.clvPct ?? null,
                  settledAt: row.settledAt ?? null,
                })),
            );
          } catch (err) {
            logger.warn(
              "SettlementApply",
              `attachSettlementOutcomes failed: ${(err as Error).message}`,
            );
          }

          // 4. Feed drift detector (ADWIN) with settled bet outcomes
          //    This tracks model performance drift and triggers retraining
          try {
            const { observeBet } = await import("../ml/drift-detector");
            const { settlePilotBet } = await import("../ml/pilot");
            for (const row of settledRows) {
              const outcome = row.outcome;
              if (!outcome || outcome === "void") continue;
              const mlScore = row.mlScore;
              const unitReturn = computeUnitReturnFromRow(row);
              observeBet({
                unitReturn,
                outcome: outcome === "won" || outcome === "half_won" ? 1 : 0,
                mlScore: mlScore ?? null,
              });
              // Feed pilot experiment if active
              if (unitReturn != null) {
                try {
                  settlePilotBet(row.id, unitReturn);
                } catch {
                  /* non-critical */
                }
              }
            }
          } catch {
            // Non-critical — drift detection feeds are fire-and-forget
          }
        })
        .catch((err) => {
          logger.warn(
            "SettlementApply",
            `ML training data hooks failed: ${(err as Error).message}`,
          );
        });
    }
  }

  return applied;
}

function computeUnitReturnFromRow(row: ValueBetRow): number | null {
  const outcome = row.outcome;
  if (!outcome || outcome === "void") return null;
  const odds = Number(row.softOdds ?? row.odds ?? 0);
  if (odds <= 1.01) return null;
  const commissionPct = Number(row.softCommissionPct ?? 0);
  const b = (odds - 1) * (1 - commissionPct / 100);
  switch (outcome) {
    case "won":
      return b;
    case "half_won":
      return b * 0.5;
    case "lost":
      return -1;
    case "half_lost":
      return -0.5;
    default:
      return null;
  }
}
