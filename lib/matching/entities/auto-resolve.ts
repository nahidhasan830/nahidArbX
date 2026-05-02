/**
 * Auto-resolver — staged pipeline that decides whether a candidate
 * (surface → entity) link gets auto-confirmed, auto-rejected, or
 * escalated to the operator inbox.
 *
 * Pipeline (stop on first verdict; cheaper stages first):
 *
 *   Stage 0  Deterministic gates       (free)
 *   Stage 1  Blocklist check           (one Postgres query)
 *   Stage 2  Bayesian evidence         (free; uses already-accumulated counters)
 *   Stage 3  Bi-encoder cosine         (~50 ms HTTP)
 *   Stage 4  Cross-encoder + conformal (~150 ms HTTP, gated on calibrator)
 *   Stage 5  Escalate                  (leave status='candidate' → operator inbox)
 *
 * Called fire-and-forget from `recordObservation()` so the sync hot path
 * never waits on it. The resolved status flip + cache invalidation
 * happens asynchronously, becoming effective in the NEXT sync tick.
 *
 * Failure mode: any stage returning null (HTTP fail, model down) skips
 * that stage. If everything fails, candidate stays 'candidate' → operator
 * inbox catches it. The sync never breaks.
 */

import { logger } from "../../shared/logger";
import {
  getEntityById,
  insertObservation,
  setEntityNameStatus,
  updateNameAfterObservation,
  type EntityNameRow,
} from "../../db/repositories/entities";
import { isBlocked } from "./blocklist";
import { scoreBiEncoder, scoreCrossEncoder } from "./matcher-client";
import { gendersDiffer, teamVariantsDiffer } from "./normalize";
import { notifyResolverInvalidation } from "./resolver";

const tag = "AutoResolve";

// ─── Tunables ──────────────────────────────────────────────────────────

// Stage 2 — Bayesian early-promote (carried over from the legacy promoter).
const BAYES_PROMOTE_EVIDENCE = 2.0;
const BAYES_NEGATIVE_PENALTY_ALPHA = 1.5;
const BAYES_MIN_POSITIVE_OBS = 2;
const BAYES_MIN_HOURS_BETWEEN_OBS = 1; // anti-ratchet on a single provider

// Stage 3 — Bi-encoder cosine thresholds.
//
// 0.85 (not 0.92) auto-confirm because BGE-M3 lands clearly-same teams
// in the 0.85–0.95 band when one side has abbreviations or suffixes
// (e.g. "Real Madrid" vs "R. Madrid CF" measured at 0.628 in smoke
// test — too low for any threshold; "Bayern" vs "Bayern München" lands
// near 0.94; "Real Madrid" vs "Real Madrid CF" near 0.88). 0.85 is the
// balanced middle: captures the easy cases while still gating on the
// cross-encoder for ambiguous ones. Tighten to 0.92 if false-positive
// rate exceeds the 0.5% SLO during the first weeks.
const BI_AUTO_CONFIRM = 0.85;
const BI_AUTO_REJECT = 0.5;

// Stage 4 — Cross-encoder + conformal thresholds.
const XE_AUTO_CONFIRM_PVALUE = 0.05;
const XE_AUTO_CONFIRM_SCORE = 0.9;
const XE_AUTO_REJECT_PVALUE = 0.05;
const XE_AUTO_REJECT_SCORE = 0.1;

// ─── Types ─────────────────────────────────────────────────────────────

export type AutoResolveStage =
  | "gates"
  | "blocklist"
  | "bayesian"
  | "bi-encoder"
  | "cross-encoder"
  | "escalate";

export type AutoResolveDecision = "auto-confirm" | "auto-reject" | "escalate";

export interface AutoResolveResult {
  decision: AutoResolveDecision;
  stage: AutoResolveStage;
  score?: number;
  pvalue?: number;
  reason: string;
  modelVersion?: string;
}

export interface AutoResolveInput {
  candidate: EntityNameRow;
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Resolve one candidate. Idempotent — calling this twice on the same
 * candidate produces the same decision. Side effects: flips
 * entity_names.status (only if decision is auto-confirm | auto-reject)
 * and emits a LISTEN/NOTIFY cache invalidation.
 *
 * Never throws — all errors become `{ decision: 'escalate' }`.
 */
export async function autoResolve(
  input: AutoResolveInput,
): Promise<AutoResolveResult> {
  try {
    const result = await runStages(input);
    await applyVerdict(input.candidate, result);
    return result;
  } catch (err) {
    logger.warn(tag, `autoResolve threw: ${(err as Error).message}`);
    return {
      decision: "escalate",
      stage: "escalate",
      reason: `error: ${(err as Error).message}`,
    };
  }
}

// ─── Pipeline ──────────────────────────────────────────────────────────

async function runStages(input: AutoResolveInput): Promise<AutoResolveResult> {
  const c = input.candidate;
  const entity = await getEntityById(c.entityId);

  if (!entity) {
    return {
      decision: "escalate",
      stage: "escalate",
      reason: "candidate's entity is missing",
    };
  }
  if (entity.retiredAt) {
    return {
      decision: "auto-reject",
      stage: "gates",
      reason: "entity is retired",
    };
  }

  // Stage 0 — deterministic gates
  //
  // Skip gender gate when the entity belongs to a women's competition.
  // Providers like NineWickets omit (W) markers — "Manchester United"
  // in the WSL context is women's, not men's.
  const skipGenderGate = c.competitionId
    ? await isWomensCompetitionById(c.competitionId)
    : false;
  if (!skipGenderGate && gendersDiffer(c.surfaceRaw, entity.canonicalName)) {
    return {
      decision: "auto-reject",
      stage: "gates",
      reason: "gender mismatch (men's vs women's)",
    };
  }
  if (teamVariantsDiffer(c.surfaceRaw, entity.canonicalName)) {
    return {
      decision: "auto-reject",
      stage: "gates",
      reason: "variant mismatch (U17/U23/reserves/futsal/etc.)",
    };
  }

  // Stage 1 — blocklist check
  // The operator has previously rejected this exact (provider, surface,
  // comp, entity) tuple within the last 30 days. Don't re-apply the same
  // wrong decision; let it sit in the inbox instead.
  const blocked = await isBlocked({
    provider: c.provider,
    surfaceNormalized: c.surfaceNormalized,
    competitionId: c.competitionId,
    candidateEntityId: c.entityId,
  });
  if (blocked) {
    return {
      decision: "escalate",
      stage: "blocklist",
      reason:
        "operator previously overrode this; skip auto-confirm for 30 days",
    };
  }

  // Stage 2 — Bayesian evidence (free, uses accumulated counters)
  const bayes = bayesianVerdict(c);
  if (bayes) return bayes;

  // Stage 3 — bi-encoder cosine similarity
  const cos = await scoreBiEncoder(c.surfaceRaw, entity.canonicalName, {
    provider: c.provider,
  });
  if (cos !== null) {
    if (cos >= BI_AUTO_CONFIRM) {
      return {
        decision: "auto-confirm",
        stage: "bi-encoder",
        score: cos,
        reason: `bi-encoder cosine ${cos.toFixed(3)} ≥ ${BI_AUTO_CONFIRM}`,
      };
    }
    if (cos <= BI_AUTO_REJECT) {
      return {
        decision: "auto-reject",
        stage: "bi-encoder",
        score: cos,
        reason: `bi-encoder cosine ${cos.toFixed(3)} ≤ ${BI_AUTO_REJECT}`,
      };
    }
  }

  // Stage 4 — cross-encoder + conformal calibration
  const xe = await scoreCrossEncoder(c.surfaceRaw, entity.canonicalName, {
    provider: c.provider,
  });
  if (
    xe !== null &&
    xe.pvalue !== null &&
    xe.model_version !== "uncalibrated"
  ) {
    if (
      xe.pvalue <= XE_AUTO_CONFIRM_PVALUE &&
      xe.score >= XE_AUTO_CONFIRM_SCORE
    ) {
      return {
        decision: "auto-confirm",
        stage: "cross-encoder",
        score: xe.score,
        pvalue: xe.pvalue,
        modelVersion: xe.model_version,
        reason: `cross-encoder p=${xe.pvalue.toFixed(3)}, score ${xe.score.toFixed(3)}`,
      };
    }
    if (
      xe.pvalue <= XE_AUTO_REJECT_PVALUE &&
      xe.score <= XE_AUTO_REJECT_SCORE
    ) {
      return {
        decision: "auto-reject",
        stage: "cross-encoder",
        score: xe.score,
        pvalue: xe.pvalue,
        modelVersion: xe.model_version,
        reason: `cross-encoder p=${xe.pvalue.toFixed(3)}, score ${xe.score.toFixed(3)}`,
      };
    }
  }

  // Stage 5 — escalate to operator inbox
  return {
    decision: "escalate",
    stage: "escalate",
    score: xe?.score,
    pvalue: xe?.pvalue ?? undefined,
    modelVersion: xe?.model_version,
    reason: xe
      ? `uncertain (p=${xe.pvalue?.toFixed(3) ?? "n/a"}, score ${xe.score.toFixed(3)})`
      : cos !== null
        ? `bi-encoder cosine ${cos.toFixed(3)} in uncertain band; cross-encoder unavailable`
        : "matcher service unreachable",
  };
}

/**
 * Bayesian evidence — free auto-promote when a candidate has accumulated
 * enough trustworthy positive observations across providers + time.
 * This is the legacy Tier-1 logic; it survives because it works and
 * doesn't need ML.
 */
function bayesianVerdict(c: EntityNameRow): AutoResolveResult | null {
  if (c.positiveObs < BAYES_MIN_POSITIVE_OBS) return null;

  // Anti-ratchet: a single provider's repeated emission of the same name
  // across milliseconds shouldn't count as multiple observations.
  const firstSeen = new Date(c.firstSeenAt).getTime();
  const lastSeen = new Date(c.lastSeenAt).getTime();
  const hoursSpread = (lastSeen - firstSeen) / 3_600_000;
  // High-trust bypass: operator-sourced observations carry weight ≥ 8
  // (provider_weight × match-review multiplier of 4). A single human
  // approval should promote without waiting for temporal spread — the
  // 1h requirement is anti-spam, not anti-human.
  const isHighTrust = c.weight >= 6;
  if (hoursSpread < BAYES_MIN_HOURS_BETWEEN_OBS && !isHighTrust) return null;

  const evidence =
    Math.log(c.weight + 1) -
    BAYES_NEGATIVE_PENALTY_ALPHA * Math.log(c.negativeObs + 1);

  if (evidence >= BAYES_PROMOTE_EVIDENCE) {
    return {
      decision: "auto-confirm",
      stage: "bayesian",
      score: evidence,
      reason: `evidence ${evidence.toFixed(2)} ≥ ${BAYES_PROMOTE_EVIDENCE} after ${c.positiveObs} positive obs (${hoursSpread.toFixed(1)}h spread)`,
    };
  }
  return null;
}

// ─── Side effects ──────────────────────────────────────────────────────

async function applyVerdict(
  candidate: EntityNameRow,
  result: AutoResolveResult,
): Promise<void> {
  try {
    // Always write the ML score back to entity_names so the inbox query
    // (classifierScore IS NOT NULL) can find escalated candidates.
    if (result.score !== undefined) {
      await updateNameAfterObservation(candidate.id, {
        classifierScore: result.score,
      });
    }

    if (result.decision === "escalate") return;
    if (result.decision === "auto-confirm" && candidate.status === "active")
      return;
    if (result.decision === "auto-reject" && candidate.status === "retired")
      return;

    const newStatus = result.decision === "auto-confirm" ? "active" : "retired";
    await setEntityNameStatus(candidate.id, newStatus);

    // Record the auto-decision as an observation so it shows in the
    // "Recent Auto-decisions" feed and as training data for the trainer.
    await insertObservation({
      surfaceRaw: candidate.surfaceRaw,
      surfaceNormalized: candidate.surfaceNormalized,
      competitionId: candidate.competitionId,
      provider: candidate.provider,
      pairedWithEntityId: candidate.entityId,
      matchScore: result.score ?? null,
      classifierScore: result.score ?? null,
      outcome: result.decision,
      source: "auto-resolver",
      metadata: {
        auto: true,
        stage: result.stage,
        reason: result.reason,
        pvalue: result.pvalue,
        modelVersion: result.modelVersion,
        entity_name_id: candidate.id,
      },
    });

    logger.info(
      tag,
      `${result.decision} ${candidate.surfaceRaw} → entity ${candidate.entityId} ` +
        `(${result.stage}: ${result.reason})`,
    );
    await notifyResolverInvalidation();
  } catch (err) {
    logger.warn(tag, `applyVerdict failed: ${(err as Error).message}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

const WOMEN_COMP_RE = [
  /\bwsl\b/i,
  /\bwomen/i,
  /\bfeminin/i,
  /\bfrauen/i,
  /\bdames\b/i,
  /\bvrouwen\b/i,
  /\bfemenin/i,
  /\(w\)/i,
  /\bladies\b/i,
  /\bnwsl\b/i,
  /\bliga\s*f\b/i,
  /\bshe\s*believes/i,
  /\bw[\s-]?league/i,
];

/**
 * Check if a competition entity represents a women's league. Uses the
 * entity's canonical name against a set of known patterns. This is
 * cheap (single PK lookup + in-memory regex) and can't fail silently
 * — unknown competitions return false, which preserves the gender
 * gate's default behaviour.
 */
async function isWomensCompetitionById(compId: string): Promise<boolean> {
  const ent = await getEntityById(compId);
  if (!ent) return false;
  return WOMEN_COMP_RE.some((re) => re.test(ent.canonicalName));
}
