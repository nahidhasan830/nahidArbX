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
 *   3. ML gate:
 *      - observe/no model: pass through baseline staking
 *      - gate_only+: requires a scored bet and learned-policy approval
 *   4. Market phase gate (pre-match / in-play) from Strategy & limits
 */
import { isAutoPlaceEnabled } from "./auto-place-config";
import { getBettingProvider } from "./registry";
import { placeBetForValueBet } from "./placer";
import { getBetById, type ValueBetRow } from "@/lib/db/repositories/bets";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { recordDecision } from "@/lib/db/repositories/auto-placer-log";
import { logger } from "@/lib/shared/logger";
import type { ValueBet } from "@/lib/atoms/value-detector";
import type { MLPermissionLevel } from "@/lib/ml/deployment-gate";
import {
  getMarketPhase,
  isMarketPhaseAllowed,
  marketPhaseLabel,
} from "@/lib/betting/market-phase";

export interface MaybeAutoPlaceOptions {
  /** Calibrated ML win probability [0, 1]; null when not scored. */
  mlScore?: number | null;
  /**
   * ML multiplier for fullKelly (undefined/null = no ML gate decision;
   * 0 = skip; 1 = pass-through; 0<x<1 = reduce; x>1 = increase).
   */
  mlKellyMultiplier?: number | null;
  /** Current deployed model permission. Defaults to shadow to fail closed. */
  permissionLevel?: MLPermissionLevel;
}

/**
 * Called by the reactive detector after persistence of changed bets.
 * Safe to call on updates too — the placer's dedup index guarantees
 * idempotency.
 *
 * @param vb - The value bet to consider for auto-placement
 * @param options - ML audit context plus the permission level that decides
 * whether ML may control real auto-placement.
 */
export async function maybeAutoPlace(
  vb: ValueBet,
  options: MaybeAutoPlaceOptions = {},
): Promise<void> {
  const stableId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
  const mlScore = options.mlScore ?? null;
  const permissionLevel = options.permissionLevel ?? "observe";

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
    mlScore,
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

  // ── ML gate ────────────────────────────────────────────────────────
  // observe means "score and log only" and must not change baseline
  // auto-placement. Active permissions (gate_only+) fail closed if the
  // bet cannot be scored or the model score fails the learned policy gate.
  const { row: settings } = await getBettingSettings();
  const mlMultiplier = options.mlKellyMultiplier;
  if (permissionLevel !== "observe") {
    if (mlScore == null) {
      recordDecision({
        ...logBase,
        gate: "ml_score",
        status: "skipped",
        reason:
          "ML score unavailable; active ML permission requires a scored bet",
      });
      return;
    }
    if (mlMultiplier == null) {
      recordDecision({
        ...logBase,
        gate: "ml_score",
        status: "skipped",
        reason:
          "ML edge unavailable; active ML permission requires a model gate decision",
      });
      return;
    }
    if (mlMultiplier <= 0) {
      logger.info(
        "AutoPlacer",
        `[${vb.softProvider}] ${stableId} → skipped: ML model edge is below learned policy threshold`,
      );
      recordDecision({
        ...logBase,
        gate: "ml_score",
        status: "skipped",
        reason: "ML model edge is below learned policy threshold",
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

  if (!isMarketPhaseAllowed(row.eventStartTime, settings.betPlacementPhases)) {
    const phase = getMarketPhase(row.eventStartTime);
    recordDecision({
      ...logBase,
      homeTeam: row.homeTeam ?? null,
      awayTeam: row.awayTeam ?? null,
      competition: row.competition ?? null,
      eventStartTime: row.eventStartTime ?? null,
      marketType: row.marketType ?? null,
      atomLabel: row.atomLabel ?? null,
      gate: "phase",
      status: "skipped",
      reason: `Bet placement disabled for ${marketPhaseLabel(phase)} events`,
    });
    return;
  }

  const outcome = await placeBetForValueBet({
    valueBet: row as unknown as ValueBetRow,
    kellyStake: vb.kellyStake,
    mlScore,
    mlKellyMultiplier: permissionLevel === "observe" ? null : mlMultiplier,
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
  // here for gates checked in this function (toggle, adapter,
  // ml_score, row_missing, phase). The placer handles the rest.
}
