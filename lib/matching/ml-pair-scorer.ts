/**
 * ML Pair Scorer — batch-scores event pairs using BGE-M3 embeddings.
 *
 * Takes match_pairs rows, collects all unique team/competition names,
 * calls embedBatch() once to get embeddings, then computes cosine
 * similarities locally. Returns per-pair ML scores + a verdict
 * (auto-merge / auto-reject / uncertain).
 *
 * The cross-encoder is optionally invoked for pairs in the uncertain
 * band (bi-encoder combined 0.70–0.89) to sharpen the decision.
 */

import type { MatchPairRow } from "../db/schema";
import { embedBatch, scoreCrossEncoder } from "./entities/matcher-client";
import { logger } from "../shared/logger";

const tag = "MlPairScorer";

// ─── Thresholds ────────────────────────────────────────────────────────

/** Both team cosines ≥ this AND comp cosine ≥ COMP_MERGE → auto-merge */
export const TEAM_MERGE_THRESHOLD = 0.9;
/** Competition cosine floor for auto-merge */
export const COMP_MERGE_THRESHOLD = 0.75;
/** Any team cosine ≤ this → auto-reject */
export const TEAM_REJECT_THRESHOLD = 0.5;
/** Combined score ≥ this → auto-merge (weighted blend) */
export const COMBINED_MERGE_THRESHOLD = 0.88;
/** Combined score ≤ this → auto-reject */
export const COMBINED_REJECT_THRESHOLD = 0.5;

/** Bi-encoder uncertain band — cross-encoder escalation */
export const XE_ESCALATION_LOW = 0.7;
export const XE_ESCALATION_HIGH = 0.89;
/** Cross-encoder auto-merge when score ≥ this AND p-value ≤ XE_PVALUE */
export const XE_MERGE_THRESHOLD = 0.9;
export const XE_PVALUE_THRESHOLD = 0.05;

// ─── Score weights ─────────────────────────────────────────────────────

const W_TEAM = 0.7;
const W_COMP = 0.3;

// ─── Types ─────────────────────────────────────────────────────────────

export type MlVerdict = "auto-merge" | "auto-reject" | "uncertain";

export interface PairMlResult {
  pairId: string;
  homeCosine: number;
  awayCosine: number;
  compCosine: number;
  combinedScore: number;
  verdict: MlVerdict;
  xeScore?: number;
  xePvalue?: number | null;
  modelVersion: string;
}

export interface BatchResult {
  results: PairMlResult[];
  embeddingTimeMs: number;
  scoringTimeMs: number;
}

// ─── Cosine similarity ─────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Verdict logic ─────────────────────────────────────────────────────

function computeVerdict(
  homeCos: number,
  awayCos: number,
  compCos: number,
  combined: number,
): MlVerdict {
  const worstTeamCos = Math.min(homeCos, awayCos);

  if (worstTeamCos <= TEAM_REJECT_THRESHOLD) return "auto-reject";
  if (combined <= COMBINED_REJECT_THRESHOLD) return "auto-reject";

  if (worstTeamCos >= TEAM_MERGE_THRESHOLD && compCos >= COMP_MERGE_THRESHOLD) {
    return "auto-merge";
  }
  if (combined >= COMBINED_MERGE_THRESHOLD) return "auto-merge";

  return "uncertain";
}

// ─── Main batch scoring ────────────────────────────────────────────────

/**
 * Score a batch of match pairs using bi-encoder embeddings. Pairs whose
 * bi-encoder score falls in the uncertain band are optionally escalated
 * to the cross-encoder.
 *
 * Returns null if the matcher service is unreachable (all pairs should
 * stay in their current stage for retry).
 */
export async function scorePairsBatch(
  pairs: MatchPairRow[],
  opts?: { escalateToCrossEncoder?: boolean },
): Promise<BatchResult | null> {
  if (pairs.length === 0)
    return { results: [], embeddingTimeMs: 0, scoringTimeMs: 0 };

  const escalate = opts?.escalateToCrossEncoder ?? true;

  // Collect unique names across all pairs. For each pair we need:
  //   homeA↔homeB, awayA↔awayB (normal orientation)
  //   homeA↔awayB, awayA↔homeB (swapped orientation — pick best)
  //   compA↔compB
  const nameSet = new Set<string>();
  for (const p of pairs) {
    nameSet.add(p.eventAHomeTeam);
    nameSet.add(p.eventAAwayTeam);
    nameSet.add(p.eventACompetition);
    nameSet.add(p.eventBHomeTeam);
    nameSet.add(p.eventBAwayTeam);
    nameSet.add(p.eventBCompetition);
  }

  const t0 = Date.now();
  const embeddings = await embedBatch([...nameSet]);
  const embeddingTimeMs = Date.now() - t0;

  if (!embeddings) {
    logger.warn(tag, "embedBatch returned null — matcher service unreachable");
    return null;
  }

  logger.info(
    tag,
    `Embedded ${embeddings.size} unique names in ${embeddingTimeMs}ms`,
  );

  const t1 = Date.now();
  const results: PairMlResult[] = [];

  for (const p of pairs) {
    const vecAHome = embeddings.get(p.eventAHomeTeam);
    const vecAAway = embeddings.get(p.eventAAwayTeam);
    const vecAComp = embeddings.get(p.eventACompetition);
    const vecBHome = embeddings.get(p.eventBHomeTeam);
    const vecBAway = embeddings.get(p.eventBAwayTeam);
    const vecBComp = embeddings.get(p.eventBCompetition);

    if (
      !vecAHome ||
      !vecAAway ||
      !vecAComp ||
      !vecBHome ||
      !vecBAway ||
      !vecBComp
    ) {
      results.push({
        pairId: p.id,
        homeCosine: 0,
        awayCosine: 0,
        compCosine: 0,
        combinedScore: 0,
        verdict: "uncertain",
        modelVersion: "bge-m3",
      });
      continue;
    }

    // Normal orientation: homeA↔homeB, awayA↔awayB
    const homeHomeCos = cosineSimilarity(vecAHome, vecBHome);
    const awayAwayCos = cosineSimilarity(vecAAway, vecBAway);
    const normalTeam = (homeHomeCos + awayAwayCos) / 2;

    // Swapped orientation: homeA↔awayB, awayA↔homeB
    const homeAwayCos = cosineSimilarity(vecAHome, vecBAway);
    const awayHomeCos = cosineSimilarity(vecAAway, vecBHome);
    const swappedTeam = (homeAwayCos + awayHomeCos) / 2;

    let homeCosine: number;
    let awayCosine: number;
    if (normalTeam >= swappedTeam) {
      homeCosine = homeHomeCos;
      awayCosine = awayAwayCos;
    } else {
      homeCosine = homeAwayCos;
      awayCosine = awayHomeCos;
    }

    const compCosine = cosineSimilarity(vecAComp, vecBComp);
    const teamScore = Math.max(normalTeam, swappedTeam);
    const combinedScore = W_TEAM * teamScore + W_COMP * compCosine;

    const verdict = computeVerdict(
      homeCosine,
      awayCosine,
      compCosine,
      combinedScore,
    );

    results.push({
      pairId: p.id,
      homeCosine,
      awayCosine,
      compCosine,
      combinedScore,
      verdict,
      modelVersion: "bge-m3",
    });
  }

  // Cross-encoder escalation for uncertain pairs
  if (escalate) {
    const uncertainPairs = results.filter(
      (r) =>
        r.verdict === "uncertain" &&
        r.combinedScore >= XE_ESCALATION_LOW &&
        r.combinedScore <= XE_ESCALATION_HIGH,
    );

    if (uncertainPairs.length > 0) {
      logger.info(
        tag,
        `Escalating ${uncertainPairs.length} uncertain pairs to cross-encoder`,
      );

      const pairMap = new Map(pairs.map((p) => [p.id, p]));

      for (const result of uncertainPairs) {
        const pair = pairMap.get(result.pairId);
        if (!pair) continue;

        // Score home teams
        const homeXe = await scoreCrossEncoder(
          pair.eventAHomeTeam,
          pair.eventBHomeTeam,
        );
        // Score away teams
        const awayXe = await scoreCrossEncoder(
          pair.eventAAwayTeam,
          pair.eventBAwayTeam,
        );

        if (homeXe && awayXe) {
          const avgXeScore = (homeXe.score + awayXe.score) / 2;
          const worstPvalue =
            homeXe.pvalue != null && awayXe.pvalue != null
              ? Math.max(homeXe.pvalue, awayXe.pvalue)
              : null;

          result.xeScore = avgXeScore;
          result.xePvalue = worstPvalue;

          if (
            avgXeScore >= XE_MERGE_THRESHOLD &&
            worstPvalue != null &&
            worstPvalue <= XE_PVALUE_THRESHOLD
          ) {
            result.verdict = "auto-merge";
          } else if (avgXeScore < TEAM_REJECT_THRESHOLD) {
            result.verdict = "auto-reject";
          }
        }
      }
    }
  }

  const scoringTimeMs = Date.now() - t1;
  logger.info(
    tag,
    `Scored ${pairs.length} pairs in ${scoringTimeMs}ms ` +
      `(${results.filter((r) => r.verdict === "auto-merge").length} merge, ` +
      `${results.filter((r) => r.verdict === "auto-reject").length} reject, ` +
      `${results.filter((r) => r.verdict === "uncertain").length} uncertain)`,
  );

  return { results, embeddingTimeMs, scoringTimeMs };
}
