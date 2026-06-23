import { isAutoPlaceEnabled } from "./auto-place-config";
import { getBettingProvider } from "./registry";
import { placeBetForValueBet } from "./placer";
import {
  getBetById,
  hasPlacedSiblingInFamily,
  type ValueBetRow,
} from "@/lib/db/repositories/bets";
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
  mlScore?: number | null;
  mlKellyMultiplier?: number | null;
  mlModelVersion?: number | null;
  mlFeatures?: number[] | null;
  mlFeatureVersion?: number | null;
  mlFeatureCount?: number | null;
  mlFeatureNamesHash?: string | null;
  permissionLevel?: MLPermissionLevel;
}

export async function maybeAutoPlace(
  vb: ValueBet,
  options: MaybeAutoPlaceOptions = {},
): Promise<void> {
  const stableId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
  const mlScore = options.mlScore ?? null;
  const permissionLevel = options.permissionLevel ?? "observe";

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

  if (
    permissionLevel !== "observe" &&
    (await hasPlacedSiblingInFamily(vb.eventId, vb.familyId, vb.atomId))
  ) {
    recordDecision({
      ...logBase,
      homeTeam: row.homeTeam ?? null,
      awayTeam: row.awayTeam ?? null,
      competition: row.competition ?? null,
      eventStartTime: row.eventStartTime ?? null,
      marketType: row.marketType ?? null,
      atomLabel: row.atomLabel ?? null,
      gate: "ml_family",
      status: "skipped",
      reason:
        "ML family deconfliction: another selection in this event/market is already reserved or placed",
    });
    return;
  }

  const outcome = await placeBetForValueBet({
    valueBet: row as unknown as ValueBetRow,
    kellyStake: vb.kellyStake,
    mlScore,
    mlKellyMultiplier: permissionLevel === "observe" ? null : mlMultiplier,
    mlModelVersion: options.mlModelVersion ?? null,
    mlFeatures: options.mlFeatures ?? null,
    mlFeatureVersion: options.mlFeatureVersion ?? null,
    mlFeatureCount: options.mlFeatureCount ?? null,
    mlFeatureNamesHash: options.mlFeatureNamesHash ?? null,
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

}
