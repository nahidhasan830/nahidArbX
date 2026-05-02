/**
 * Auto-place orchestrator. Called from the reactive detector on every
 * tick that emits a value bet — brand-new rows AND re-confirmations of
 * existing ones. Re-firing on updates is necessary because a bet skipped
 * on tick 1 (toggle off, cold market-refs cache, balance not yet loaded,
 * etc.) would otherwise never get another shot.
 *
 * Duplicate placement is prevented downstream by `placeBetForValueBet`:
 * isAlreadyPlaced (DB UNIQUE index on event/family/atom), the in-flight
 * promise map, and the 9W pending-confirmation tracker.
 *
 * Same code path as manual placement — converges on
 * `placeBetForValueBet`, which handles ref resolution, dedup, balance,
 * limits, adapter call, ledger write, and Telegram notify.
 *
 * Gates:
 *   1. Per-provider toggle (auto-place must be ON for the soft provider)
 *   2. Provider must have a registered adapter
 *   3. ML confidence gate: if mlScore is available and below the
 *      configured mlMinScore threshold, the bet is skipped. When no ML
 *      model is loaded, mlScore is undefined → gate is bypassed (same
 *      behavior as pre-ML).
 */
import { isAutoPlaceEnabled } from "./auto-place-config";
import { getBettingProvider } from "./registry";
import { placeBetForValueBet } from "./placer";
import { getBetById, type ValueBetRow } from "@/lib/db/repositories/bets";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { recordDecision } from "@/lib/db/repositories/auto-placer-log";
import { logger } from "@/lib/shared/logger";
import type { ValueBet } from "@/lib/atoms/value-detector";

/**
 * Called by the reactive detector after persistence of changed bets.
 * Safe to call on updates too — the placer's dedup index guarantees
 * idempotency.
 *
 * @param vb - The value bet to consider for auto-placement
 * @param mlScore - ML model confidence score [0, 1] (undefined = no model loaded)
 * @param mlKellyAdjusted - ML-adjusted Kelly fraction (undefined = use base Kelly)
 */
export async function maybeAutoPlace(
  vb: ValueBet,
  mlScore?: number,
  mlKellyAdjusted?: number,
): Promise<void> {
  const stableId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;

  // Minimal context for early-gate log entries (before we have the DB row).
  // ValueBet from the detector doesn't carry event display fields (homeTeam,
  // awayTeam, etc.) — those are enriched during DB persistence. We log what
  // we have; the placer will log richer context for later gates.
  const logBase = {
    betId: stableId,
    softProvider: vb.softProvider,
    homeTeam: null as string | null,
    awayTeam: null as string | null,
    competition: null as string | null,
    eventStartTime: null as string | null,
    marketType: null as string | null,
    atomLabel: null as string | null,
    softOdds: vb.softOdds ?? null,
    sharpOdds: vb.sharpOdds ?? null,
    evPct: vb.evPct ?? null,
    mlScore: mlScore ?? null,
  };

  if (!isAutoPlaceEnabled(vb.softProvider)) {
    recordDecision({
      ...logBase,
      gate: "toggle",
      status: "skipped",
      reason: `Auto-place disabled for ${vb.softProvider}`,
    });
    return;
  }
  const adapter = getBettingProvider(vb.softProvider);
  if (!adapter) {
    logger.warn(
      "AutoPlacer",
      `Auto-place ON for ${vb.softProvider} but no adapter registered`,
    );
    recordDecision({
      ...logBase,
      gate: "adapter",
      status: "skipped",
      reason: `No adapter registered for ${vb.softProvider}`,
    });
    return;
  }

  // ── ML confidence gate ──────────────────────────────────────────────
  // When an ML model is loaded and scoring, skip bets below the
  // configured minimum score. When no model is loaded, mlScore is
  // undefined and the gate is bypassed — preserving pre-ML behavior.
  if (mlScore != null) {
    const { row: settings } = await getBettingSettings();
    const minScore = settings.mlMinScore ?? 0.4;
    if (mlScore < minScore) {
      logger.info(
        "AutoPlacer",
        `[${vb.softProvider}] ${stableId} → skipped: ML score ${mlScore.toFixed(2)} < ${minScore}`,
      );
      recordDecision({
        ...logBase,
        gate: "ml_score",
        status: "skipped",
        reason: `ML score ${mlScore.toFixed(2)} < min ${minScore}`,
      });
      return;
    }
  }

  const row = await getBetById(stableId);
  if (!row) {
    logger.warn(
      "AutoPlacer",
      `ValueBet row ${stableId} not found post-persist; skipping auto-place`,
    );
    recordDecision({
      ...logBase,
      gate: "row_missing",
      status: "skipped",
      reason: `Row ${stableId} not found in DB post-persist`,
    });
    return;
  }

  const outcome = await placeBetForValueBet({
    valueBet: row as unknown as ValueBetRow,
    kellyStake: mlKellyAdjusted ?? vb.kellyStake,
    mode: "auto",
  });

  const tail =
    outcome.status === "placed" || outcome.status === "pending"
      ? ""
      : `: ${outcome.reason}`;
  logger.info(
    "AutoPlacer",
    `[${vb.softProvider}] ${stableId} → ${outcome.status}${tail}`,
  );

  // The placer records its own log entries for outcomes it produces
  // (balance, dedup, book reject, placed, etc.). We only need to record
  // here for gates checked in this function (toggle, adapter, ml_score,
  // row_missing). The placer handles the rest.
}
