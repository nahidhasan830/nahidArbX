/**
 * Auto-place orchestrator. Called from the value-bet persistence layer
 * on every tick the detector emits a value bet — brand-new rows AND
 * re-confirmations of existing ones. Re-firing on updates is necessary
 * because a bet skipped on tick 1 (toggle off, cold market-refs cache,
 * balance not yet loaded, etc.) would otherwise never get another shot.
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
 */
import { isAutoPlaceEnabled } from "./auto-place-config";
import { getBettingProvider } from "./registry";
import { placeBetForValueBet } from "./placer";
import { getValueBetById } from "@/lib/db/repositories/value-bets";
import { logger } from "@/lib/shared/logger";
import type { ValueBet } from "@/lib/atoms/value-detector";

/**
 * Called by persistValueBets after a successful insert of a NEW row.
 * Safe to call on updates too — the placer's dedup index guarantees
 * idempotency.
 */
export async function maybeAutoPlace(vb: ValueBet): Promise<void> {
  if (!isAutoPlaceEnabled(vb.softProvider)) return;
  const adapter = getBettingProvider(vb.softProvider);
  if (!adapter) {
    logger.warn(
      "AutoPlacer",
      `Auto-place ON for ${vb.softProvider} but no adapter registered`,
    );
    return;
  }

  const stableId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
  const row = await getValueBetById(stableId);
  if (!row) {
    logger.warn(
      "AutoPlacer",
      `ValueBet row ${stableId} not found post-persist; skipping auto-place`,
    );
    return;
  }

  const outcome = await placeBetForValueBet({
    valueBet: row,
    kellyStake: vb.kellyStake,
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
