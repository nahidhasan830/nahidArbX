
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


const BAYES_PROMOTE_EVIDENCE = 2.0;
const BAYES_NEGATIVE_PENALTY_ALPHA = 1.5;
const BAYES_MIN_POSITIVE_OBS = 2;
const BAYES_MIN_HOURS_BETWEEN_OBS = 1;

const BI_AUTO_CONFIRM = 0.85;
const BI_AUTO_REJECT = 0.5;

const XE_AUTO_CONFIRM_PVALUE = 0.05;
const XE_AUTO_CONFIRM_SCORE = 0.9;
const XE_AUTO_REJECT_PVALUE = 0.05;
const XE_AUTO_REJECT_SCORE = 0.1;


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

  const bayes = bayesianVerdict(c);
  if (bayes) return bayes;

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

function bayesianVerdict(c: EntityNameRow): AutoResolveResult | null {
  if (c.positiveObs < BAYES_MIN_POSITIVE_OBS) return null;

  const firstSeen = new Date(c.firstSeenAt).getTime();
  const lastSeen = new Date(c.lastSeenAt).getTime();
  const hoursSpread = (lastSeen - firstSeen) / 3_600_000;
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


async function applyVerdict(
  candidate: EntityNameRow,
  result: AutoResolveResult,
): Promise<void> {
  try {
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

async function isWomensCompetitionById(compId: string): Promise<boolean> {
  const ent = await getEntityById(compId);
  if (!ent) return false;
  return WOMEN_COMP_RE.some((re) => re.test(ent.canonicalName));
}
