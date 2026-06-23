
import { listBets, recordSettleAttempts } from "../db/repositories/bets";
import { settleBatch } from "./settle-batch";
import type { WaterfallTelemetry } from "./waterfall";
import { getApiFootballQuota } from "./sources/api-football";
import { logger } from "../shared/logger";
import {
  estimateRunCost,
  recordSettlementRun,
} from "../db/repositories/settlement-runs";
import { applySettlementOutcomes } from "./apply-outcomes";
import { notify } from "../notifier";
import { singleton } from "../util/singleton";

const SOURCE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const alertState = singleton<{ lastSentAt: number }>(
  "settle:source-alert",
  () => ({
    lastSentAt: 0,
  }),
);

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
  sourceIssues: string[];
}

const DEFAULT_BATCH_SIZE = 500;
const ONE_HOUR_MS = 60 * 60 * 1000;

const CORNER_MARKETS = new Set([
  "CORNERS",
  "HOME_CORNERS_TOTAL",
  "AWAY_CORNERS_TOTAL",
  "CORNERS_HANDICAP",
  "CORNERS_EUROPEAN_HANDICAP",
]);
const BOOKING_MARKETS = new Set(["BOOKINGS", "BOOKINGS_HANDICAP"]);

type RetryBackoffRow = {
  eventId: string;
  settleAttempts: number;
  lastSettleAttemptAt: string | null;
};

const retryDelayMs = (attempts: number): number => {
  if (attempts <= 3) return ONE_HOUR_MS;
  if (attempts <= 8) return 6 * ONE_HOUR_MS;
  return 24 * ONE_HOUR_MS;
};

const eligibleNetworkEvents = (
  rows: RetryBackoffRow[],
  nowMs: number,
): Set<string> => {
  const byEvent = new Map<
    string,
    { attempts: number; lastAttemptMs: number | null }
  >();
  for (const row of rows) {
    const current = byEvent.get(row.eventId) ?? {
      attempts: 0,
      lastAttemptMs: null,
    };
    current.attempts = Math.max(current.attempts, row.settleAttempts ?? 0);
    if (row.lastSettleAttemptAt) {
      const last = new Date(row.lastSettleAttemptAt).getTime();
      if (Number.isFinite(last)) {
        current.lastAttemptMs =
          current.lastAttemptMs == null
            ? last
            : Math.max(current.lastAttemptMs, last);
      }
    }
    byEvent.set(row.eventId, current);
  }

  const eligible = new Set<string>();
  for (const [eventId, state] of byEvent) {
    if (state.lastAttemptMs == null) {
      eligible.add(eventId);
      continue;
    }
    if (nowMs - state.lastAttemptMs >= retryDelayMs(state.attempts)) {
      eligible.add(eventId);
    }
  }
  return eligible;
};

const batchContainsCorners = (rows: { marketType: string }[]): boolean =>
  rows.some((row) => CORNER_MARKETS.has(row.marketType));

const batchContainsBookings = (rows: { marketType: string }[]): boolean =>
  rows.some((row) => BOOKING_MARKETS.has(row.marketType));

const batchContainsHtScope = (rows: { timeScope: string }[]): boolean =>
  rows.some((row) => row.timeScope === "1H" || row.timeScope === "2H");

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

const formatSourceIssue = (issue: string): string => {
  if (issue.startsWith("API-Football access issue on /fixtures:")) {
    let msg = issue.replace("API-Football access issue on /fixtures:", "API-FB:");
    msg = msg.replace(
      /plan: Free plans do not have access to this date, try from ([\d-]+) to ([\d-]+)/,
      "free plan: no access before $1 (try $2+)",
    );
    msg = msg.replace(/plan: Free plans do not have access to this date\.?/, "free plan date restriction");
    msg = msg.replace(/:\s*/, ": ");
    return msg.trim();
  }
  if (issue.startsWith("SofaScore transport is degraded after ")) {
    return issue
      .replace("SofaScore transport is degraded after ", "SofaScore: ")
      .replace(
        " consecutive direct/proxy failures. It will retry on next settlement tick.",
        " failures (retrying)",
      );
  }
  return issue;
};

const shouldSendSourceWarning = (
  telemetry: WaterfallTelemetry,
  sourceIssues: string[],
): boolean => {
  const quota = getApiFootballQuota();
  return (
    quota.remaining <= 10 ||
    sourceIssues.some((issue) => issue.includes("SofaScore transport")) ||
    telemetry.eventsSkippedByBackoff > 0 ||
    (telemetry.eventsAttempted > 0 && telemetry.eventsStillUnresolved > 0)
  );
};

const buildSourceWarning = (
  readyBets: number,
  rows: Array<{ marketType: string; timeScope: string }>,
  telemetry: WaterfallTelemetry,
  sourceIssues: string[],
): string => {
  const quota = getApiFootballQuota();

  const unresolved = telemetry.eventsStillUnresolved;
  const tried = telemetry.eventsAttempted;
  const backoff = telemetry.eventsSkippedByBackoff;
  const used = telemetry.apiFootballRequestsUsed;

  const lines: string[] = [
    `Settlement sources · ${unresolved} unresolved`,
    `📡 ${plural(readyBets, "bet")} queued • ${tried} attempted • ${backoff} backoffs`,
    `📉 API-FB quota ${quota.remaining}/${quota.dailyLimit} • ${used} used`,
  ];

  if (sourceIssues.length > 0) {
    for (const issue of sourceIssues.slice(0, 2)) {
      lines.push(`• ${formatSourceIssue(issue)}`);
    }
    if (sourceIssues.length > 2) {
      lines.push(`• +${sourceIssues.length - 2} more`);
    }
  }

  const needs: string[] = [];
  if (batchContainsCorners(rows)) needs.push("corners");
  if (batchContainsBookings(rows)) needs.push("bookings");
  if (batchContainsHtScope(rows)) needs.push("half-time scores");
  if (needs.length > 0) {
    lines.push(`📊 Needs: ${needs.join(", ")}`);
  }

  return lines.join("\n");
};

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
      eventsTotal: res.telemetry.eventsTotal,
      eventsAttempted: res.telemetry.eventsAttempted,
      eventsSkippedByBackoff: res.telemetry.eventsSkippedByBackoff,
      eventsResolvedFromCache: res.telemetry.eventsResolvedFromCache,
      eventsResolvedByEspn: res.telemetry.eventsResolvedByEspn,
      eventsResolvedBySofaScore: res.telemetry.eventsResolvedBySofaScore,
      eventsResolvedByApiFootball: res.telemetry.eventsResolvedByApiFootball,
      eventsStillUnresolved: res.telemetry.eventsStillUnresolved,
      apiFootballRequestsUsed: res.telemetry.apiFootballRequestsUsed,
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
    eventsTotal: 0,
    eventsAttempted: 0,
    eventsSkippedByBackoff: 0,
    eventsResolvedFromCache: 0,
    eventsResolvedByEspn: 0,
    eventsResolvedBySofaScore: 0,
    eventsResolvedByApiFootball: 0,
    eventsStillUnresolved: 0,
    apiFootballRequestsUsed: 0,
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
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const networkEventIds = eligibleNetworkEvents(rows, Date.now());
  const eventCount = new Set(rows.map((row) => row.eventId)).size;
  let batchResult;
  try {
    batchResult = await settleBatch(ids, { networkEventIds });
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
        total: eventCount,
        eventsTotal: eventCount,
        unresolved: ids.length,
        eventsStillUnresolved: eventCount,
        unresolvedEvents: eventCount,
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
  const updates = resolved.map((p) => ({
    id: p.id,
    outcome: p.proposedOutcome,
    source: p.source ?? null,
    score: p.score,
  }));

  try {
    const attemptedEvents = new Set(
      batchResult.eventBreakdown.networkAttemptedEventIds,
    );
    const unresolvedEvents = new Set(
      batchResult.eventBreakdown.stillUnresolvedEventIds,
    );
    const attemptedPendingIds = batchResult.proposals
      .filter((proposal) => proposal.proposedOutcome === "pending")
      .map((proposal) => {
        const row = rowById.get(proposal.id);
        return row &&
          attemptedEvents.has(row.eventId) &&
          unresolvedEvents.has(row.eventId)
          ? proposal.id
          : null;
      })
      .filter((id): id is string => !!id);
    await recordSettleAttempts(attemptedPendingIds);
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

  if (
    shouldSendSourceWarning(batchResult.telemetry, result.sourceIssues) &&
    Date.now() - alertState.lastSentAt > SOURCE_ALERT_COOLDOWN_MS
  ) {
    alertState.lastSentAt = Date.now();
    notify({
      type: "system",
      at: new Date().toISOString(),
      severity: "warn",
      message: buildSourceWarning(
        ids.length,
        rows,
        batchResult.telemetry,
        result.sourceIssues,
      ),
    }).catch(() => {});
  }

  logger.info(
    "AutoSettle",
    `swept ${ids.length} bets across ${batchResult.telemetry.total} events — ` +
      `settled ${result.settled} (applied ${applied}), ` +
      `still-pending ${result.stillPending}. ` +
      `Events: attempted=${batchResult.telemetry.eventsAttempted} ` +
      `backoff=${batchResult.telemetry.eventsSkippedByBackoff} ` +
      `cache=${batchResult.telemetry.eventsResolvedFromCache} ` +
      `espn=${batchResult.telemetry.eventsResolvedByEspn} ` +
      `sofa=${batchResult.telemetry.eventsResolvedBySofaScore} ` +
      `apifb=${batchResult.telemetry.eventsResolvedByApiFootball} ` +
      `unresolved=${batchResult.telemetry.eventsStillUnresolved}. ` +
      `API-Football used=${batchResult.telemetry.apiFootballRequestsUsed}. ` +
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
