/**
 * settleBatch — top-level settlement entry point.
 *
 * Replaces the per-bet Gemini fan-out from `labelOutcomesForBets`. Given a
 * list of value-bet row IDs:
 *   1. Dedupe to unique eventIds.
 *   2. Run the waterfall to resolve each eventId's final score once.
 *   3. Apply deterministic `settleBet(row, score)` per bet.
 * Bets whose market isn't covered by the pure settler (or whose event
 * couldn't be resolved at any tier) are returned with outcome "pending"
 * and a reason the caller can use to decide whether to escalate.
 */

import { getBetsByIds } from "../db/repositories/bets";
import type { ValueBetRow } from "@/lib/bets-history/types";
import {
  resolveScores,
  type WaterfallTelemetry,
  type SettleEvent,
} from "./waterfall";
import { settleBet } from "./settle-bet";
import type { SettleResult } from "./types";
import type { Outcome } from "../bets-history/types";
import {
  assertWithinRequestCeiling,
  type AiMode,
  type AiModel,
} from "./cost-guard";
import { recordAiActivity } from "../db/repositories/ai-activity-log";

export interface SettleBatchOptions {
  /**
   * Skip Tier 0 (DB cache) so the waterfall re-resolves events even when
   * an old score is cached. Useful for "Re-run default pipeline" in the UI.
   */
  bypassCache?: boolean;
  /**
   * Operator-triggered: send events straight to Tier 3 Gemini. The ONLY
   * way this batch invokes paid AI; never set by the automatic
   * scheduler. Set true by the manual "AI settle" dialog on `/bets`.
   */
  forceAi?: boolean;
  /** Which Gemini tier to use when Tier 3 fires. Defaults to Lite. */
  aiModel?: "lite" | "flash" | "pro";
}

export interface SettleProposal {
  id: string;
  proposedOutcome: Outcome;
  confidence: number;
  reasoning: string;
  score: string;
  tier: "pure" | "unresolved";
  source: string | null;
}

export interface SettleBatchResult {
  proposals: SettleProposal[];
  missing: string[];
  telemetry: WaterfallTelemetry & {
    settledDeterministically: number;
    unsupported: number;
    unresolvedEvents: number;
  };
}

const buildProposal = (
  row: ValueBetRow,
  r: SettleResult,
  source: string | null,
): SettleProposal => ({
  id: row.id,
  proposedOutcome: r.outcome,
  confidence: r.confidence,
  reasoning: r.reasoning,
  score: r.scopeScore,
  tier: r.outcome === "pending" ? "unresolved" : "pure",
  source,
});

export async function settleBatch(
  ids: string[],
  options: SettleBatchOptions = {},
): Promise<SettleBatchResult> {
  const startMs = Date.now();
  const rows = await getBetsByIds(ids);
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));

  // Dedupe by eventId, keeping a single metadata copy per event. When the
  // same event appears on multiple bets the team/time fields are identical
  // by construction (denormalized at persist time), so the first row wins.
  const eventMap = new Map<string, SettleEvent>();
  for (const r of rows) {
    if (!eventMap.has(r.eventId)) {
      eventMap.set(r.eventId, {
        eventId: r.eventId,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        competition: r.competition,
        startTime: r.eventStartTime,
      });
    }
  }
  // Does the batch contain any corner-market bet? If so, ask the
  // waterfall to fetch corner stats. If not, skip the extra HTTP cost.
  const needsCorners = rows.some(
    (r) =>
      r.marketType === "CORNERS" ||
      r.marketType === "HOME_CORNERS_TOTAL" ||
      r.marketType === "AWAY_CORNERS_TOTAL" ||
      r.marketType === "CORNERS_HANDICAP" ||
      r.marketType === "CORNERS_EUROPEAN_HANDICAP",
  );

  // ── Cost guard — pre-flight ceiling only. ───────────────────────────────
  //
  // Refuses the batch if the estimated cost would exceed
  // `AI_MAX_PER_REQUEST_USD` (default $2). The UI also shows a
  // confirmation popup before calling, so this is the last-line-of-
  // defense for programmatic clients that bypass the UI.
  const willUseAi = options.forceAi === true;
  const mode: AiMode = willUseAi ? "force-ai" : "fallback";
  const model: AiModel = options.aiModel ?? "lite";
  if (willUseAi && eventMap.size > 0) {
    assertWithinRequestCeiling({
      eventCount: eventMap.size,
      model,
      mode,
    });
  }

  const { scores, telemetry } = await resolveScores([...eventMap.values()], {
    needsCorners,
    bypassCache: options.bypassCache === true,
    forceAi: options.forceAi === true,
    aiModel: options.aiModel,
  });

  let settledDeterministically = 0;
  let unsupported = 0;

  const proposals: SettleProposal[] = rows.map((row) => {
    const score = scores.get(row.eventId);
    if (!score) {
      return {
        id: row.id,
        proposedOutcome: "pending",
        confidence: 0,
        reasoning: "No final score resolved by any free tier — needs AI tier.",
        score: "",
        tier: "unresolved",
        source: null,
      };
    }
    const res = settleBet(row, score);
    if (res.outcome !== "pending") settledDeterministically++;
    else unsupported++;
    return buildProposal(row, res, score.source);
  });

  const unresolvedEvents = telemetry.unresolved;
  const durationMs = Date.now() - startMs;

  const result: SettleBatchResult = {
    proposals,
    missing,
    telemetry: {
      ...telemetry,
      settledDeterministically,
      unsupported,
      unresolvedEvents,
    },
  };

  // ── Fire-and-forget AI activity log (only when AI was actually used) ──
  // Deterministic auto-settler runs already write to `settlement_runs`
  // via persistRun() — logging them here was pure noise (null model,
  // null cost, misleading "Settlement" entries in the AI Activity page).
  if (willUseAi) {
    const hasErrors = proposals.some((p) => "error" in p);
    recordAiActivity({
      system: "settlement",
      trigger: "manual",
      status: hasErrors ? "partial" : settledDeterministically > 0 ? "success" : "error",
      model: `gemini-${model}`,
      itemCount: rows.length,
      durationMs,
      costUsd: null,
      summary: `Settled ${settledDeterministically}/${rows.length} bets (${unresolvedEvents} unresolved events)`,
      error: null,
      metadata: {
        tier0_hits: telemetry.tier0_hits,
        tier1_hits: telemetry.tier1_hits,
        tier2_hits: telemetry.tier2_hits,
        tier3_hits: telemetry.tier3_hits,
        tier4_hits: telemetry.tier4_hits,
        unsupported,
        unresolvedEvents,
        bypassCache: options.bypassCache === true,
      },
    }).catch(() => {}); // never block settlement
  }

  return result;
}

