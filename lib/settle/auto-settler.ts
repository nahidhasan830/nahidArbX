/**
 * Continuous auto-settlement: pulls every bet that has gone past its
 * settlement-ready threshold, runs them through the waterfall, and writes
 * outcomes back to the DB in one bulk update.
 *
 * Bets the waterfall can't resolve (outcome still 'pending') are left
 * untouched for the next tick — on the assumption that a later tier
 * (slower source, batched AI, human intervention) will resolve them.
 */

import { listBets, recordSettleAttempts } from "../db/repositories/bets";
import { settleBatch } from "./settle-batch";
import type { WaterfallTelemetry } from "./waterfall";
import { logger } from "../shared/logger";
import {
  estimateRunCost,
  recordSettlementRun,
} from "../db/repositories/settlement-runs";
import { applySettlementOutcomes } from "./apply-outcomes";
import { notify } from "../notifier";
import { singleton } from "../util/singleton";

// ── Source-health alert debounce ─────────────────────────────────────────
// Avoids spamming Telegram on every tick when SofaScore is down.
const SOURCE_ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const alertState = singleton<{ lastSentAt: number }>("settle:source-alert", () => ({
  lastSentAt: 0,
}));

export interface AutoSettleResult {
  scannedBets: number;
  settled: number;
  stillPending: number;
  applied: number;
  telemetry: WaterfallTelemetry & {
    settledDeterministically: number;
    unsupported: number;
    unresolvedEvents: number;
  };
  errors: string[];
  /** Non-fatal data-source access warnings (SofaScore 403, etc). */
  sourceIssues: string[];
}

const DEFAULT_BATCH_SIZE = 500;

/**
 * Run one sweep of the settlement waterfall across every `pending` bet
 * past the settle-ready threshold. Returns a summary; it does not throw —
 * the caller is usually a background interval and should be resilient
 * to partial failures.
 */
/**
 * Emit a single `settlement_runs` row per tick. Never let a telemetry
 * write failure bubble up — observability outages must not stall
 * settlement.
 */
async function persistRun(
  startedAt: string,
  finishedAt: string,
  res: AutoSettleResult,
  errorMsg: string | null,
): Promise<void> {
  try {
    const cost = estimateRunCost(
      res.telemetry.tier0_hits,
      res.telemetry.tier1_hits,
      res.telemetry.tier2_hits,
      res.telemetry.tier3_hits,
      res.telemetry.tier4_hits,
    );
    await recordSettlementRun({
      startedAt,
      finishedAt,
      durationMs: res.telemetry.durationMs,
      scannedBets: res.scannedBets,
      uniqueEvents: res.telemetry.total,
      settledDeterministically: res.telemetry.settledDeterministically,
      applied: res.applied,
      stillPending: res.stillPending,
      tier0Hits: res.telemetry.tier0_hits,
      tier1Hits: res.telemetry.tier1_hits,
      tier2Hits: res.telemetry.tier2_hits,
      tier3Hits: res.telemetry.tier3_hits,
      tier4Hits: res.telemetry.tier4_hits,
      unresolvedEvents: res.telemetry.unresolvedEvents,
      abortedReason: null,
      error: errorMsg,
      estimatedCostUsd: cost,
    });
  } catch (err) {
    logger.warn(
      "AutoSettle",
      `Telemetry write failed: ${(err as Error).message}`,
    );
  }
}

export async function runAutoSettle(
  opts: { batchSize?: number } = {},
): Promise<AutoSettleResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const errors: string[] = [];
  const startedAt = new Date().toISOString();
  const emptyTelemetry = {
    total: 0,
    tier0_hits: 0,
    tier1_hits: 0,
    tier2_hits: 0,
    tier3_hits: 0,
    tier4_hits: 0,
    unresolved: 0,
    durationMs: 0,
    sourceIssues: [] as string[],
    settledDeterministically: 0,
    unsupported: 0,
    unresolvedEvents: 0,
  };

  const { rows } = await listBets({
    readyToSettle: true,
    limit: batchSize,
  });

  if (rows.length === 0) {
    // Diagnostic: distinguish "no pending bets at all" from "pending bets
    // exist but haven't passed the 2h15m post-kickoff gate". This helps
    // operators understand why settlement isn't progressing.
    const { total: pendingTotal } = await listBets({
      outcome: "pending",
      limit: 1,
    });
    if (pendingTotal > 0) {
      logger.info(
        "AutoSettle",
        `No bets ready to settle, but ${pendingTotal} pending bet(s) exist — ` +
          "they haven't passed the 2h15m post-kickoff threshold yet. " +
          "Settlement will proceed once matches finish and the gate clears.",
      );
    }
    const result: AutoSettleResult = {
      scannedBets: 0,
      settled: 0,
      stillPending: 0,
      applied: 0,
      telemetry: emptyTelemetry,
      errors,
      sourceIssues: [],
    };
    await persistRun(startedAt, new Date().toISOString(), result, null);
    return result;
  }

  const ids = rows.map((r) => r.id);
  let batchResult;
  try {
    batchResult = await settleBatch(ids);
  } catch (err) {
    const msg = (err as Error).message;
    errors.push(`settleBatch failed: ${msg}`);
    logger.error("AutoSettle", `settleBatch threw: ${msg}`);
    const result: AutoSettleResult = {
      scannedBets: ids.length,
      settled: 0,
      stillPending: ids.length,
      applied: 0,
      telemetry: {
        ...emptyTelemetry,
        unresolved: ids.length,
        unresolvedEvents: ids.length,
        unsupported: ids.length,
      },
      errors,
      sourceIssues: [],
    };
    await persistRun(startedAt, new Date().toISOString(), result, msg);
    return result;
  }

  const resolved = batchResult.proposals.filter(
    (p) => p.proposedOutcome !== "pending",
  );
  // Persist the source alongside the outcome so audits can see exactly
  // which tier settled each bet (sofascore / espn / pinnacle-ws / …).
  const updates = resolved.map((p) => ({
    id: p.id,
    outcome: p.proposedOutcome,
    source: p.source ?? null,
    score: p.score,
  }));

  // Bump the attempt counter on every row the tick touched — including
  // ones the pipeline couldn't resolve. That's what powers the "Needs
  // review" filter (pending + settle_attempts > 0).
  try {
    await recordSettleAttempts(ids);
  } catch (err) {
    logger.warn(
      "AutoSettle",
      `recordSettleAttempts failed (non-fatal): ${(err as Error).message}`,
    );
  }

  let applied = 0;
  if (updates.length > 0) {
    try {
      applied += await applySettlementOutcomes(updates);
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`applySettlementOutcomes failed: ${msg}`);
      logger.error("AutoSettle", `applySettlementOutcomes threw: ${msg}`);
    }
  }

  const result: AutoSettleResult = {
    scannedBets: ids.length,
    settled: resolved.length,
    stillPending: ids.length - resolved.length,
    applied,
    telemetry: batchResult.telemetry,
    errors,
    sourceIssues: batchResult.telemetry.sourceIssues,
  };

  // ── Source-health Telegram alert ────────────────────────────────────────
  // Fires at most once per hour to avoid flooding the chat when SofaScore
  // is persistently blocked.
  if (
    batchResult.telemetry.sourceIssues.length > 0 &&
    Date.now() - alertState.lastSentAt > SOURCE_ALERT_COOLDOWN_MS
  ) {
    alertState.lastSentAt = Date.now();
    notify({
      type: "system",
      at: new Date().toISOString(),
      severity: "warn",
      message:
        `⚠️ Settlement data-source issues:\n` +
        batchResult.telemetry.sourceIssues.join("\n") +
        `\n\nAffected bets: ${result.stillPending} still pending. ` +
        `Bookings/corners enrichment may be degraded.`,
    }).catch(() => {});
  }

  logger.info(
    "AutoSettle",
    `swept ${ids.length} bets across ${batchResult.telemetry.total} events — ` +
      `settled ${result.settled} (applied ${applied}), ` +
      `still-pending ${result.stillPending}. ` +
      `Tier hits: T0=${batchResult.telemetry.tier0_hits} ` +
      `T1=${batchResult.telemetry.tier1_hits} ` +
      `T2=${batchResult.telemetry.tier2_hits} ` +
      `T3=${batchResult.telemetry.tier3_hits} ` +
      `T4=${batchResult.telemetry.tier4_hits}. ` +
      `Duration ${batchResult.telemetry.durationMs}ms.`,
  );
  await persistRun(
    startedAt,
    new Date().toISOString(),
    result,
    errors.length > 0 ? errors.join("; ") : null,
  );
  return result;
}
