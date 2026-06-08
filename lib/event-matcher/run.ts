import { randomUUID } from "node:crypto";
import { generateCandidates } from "./candidates";
import { getEventMatcherConfig } from "./config";
import { policyFromDeepSeek, reviewResidualWithDeepSeek } from "./deepseek";
import { confidenceBand, decideCandidate } from "./policy";
import {
  applyCompatibleCanonicalClusterMerge,
  applyCanonicalMerge,
  filterNewCandidateKeys,
  insertCandidate,
  insertDecision,
  loadRecentSnapshots,
  loadSnapshotsForDecisionIds,
  planCompatibleCanonicalClusterMerge,
  planCanonicalMerge,
  rebuildImpactForRun,
  supersedeClusterResolvedHumanReviewDecisions,
  supersedeStaleHumanReviewDecisions,
} from "./repository";
import { scoreCandidate } from "./scoring";
import type {
  EventMatcherCandidate,
  EventMatcherPolicyDecision,
  EventMatcherProgressCounters,
  EventMatcherProgressEvent,
  EventMatcherProgressPhase,
  EventMatcherRunOptions,
  EventMatcherRunSummary,
  ScoreBreakdown,
} from "./types";

function buildInitialCounters(): EventMatcherProgressCounters {
  return {
    snapshots: 0,
    generatedCandidates: 0,
    candidatesToScore: 0,
    skippedCandidates: 0,
    scoredCandidates: 0,
    insertedCandidates: 0,
    autoMerged: 0,
    autoRejected: 0,
    deepseekReviewed: 0,
    humanReview: 0,
  };
}

function candidateProgress(candidate: EventMatcherCandidate) {
  return {
    key: candidate.candidateKey,
    providerA: candidate.snapshotA.provider ?? "unknown",
    providerB: candidate.snapshotB.provider ?? "unknown",
    homeA: candidate.snapshotA.homeTeamRaw ?? "unknown",
    awayA: candidate.snapshotA.awayTeamRaw ?? "unknown",
    homeB: candidate.snapshotB.homeTeamRaw ?? "unknown",
    awayB: candidate.snapshotB.awayTeamRaw ?? "unknown",
    kickoffA:
      candidate.snapshotA.parsedKickoff instanceof Date
        ? candidate.snapshotA.parsedKickoff.toISOString()
        : "",
    kickoffB:
      candidate.snapshotB.parsedKickoff instanceof Date
        ? candidate.snapshotB.parsedKickoff.toISOString()
        : "",
  };
}

function scoreProgress(score: ScoreBreakdown) {
  return {
    combined: score.combined,
    team: score.bestTeam,
    competition: score.competition,
    kickoff: score.kickoff,
  };
}

function groundedReviewSkipPolicy(
  policy: EventMatcherPolicyDecision,
  skipReason: "disabled" | "degraded",
  degradationReason: string | null,
): EventMatcherPolicyDecision {
  const reasonCode =
    skipReason === "disabled"
      ? "grounded_review_disabled"
      : "grounded_review_degraded";
  const reasonSummary =
    skipReason === "disabled"
      ? "Search-grounded review was disabled for this matcher run."
      : `Search-grounded review was skipped because reliability is degraded${degradationReason ? `: ${degradationReason}` : "."}`;

  return {
    ...policy,
    decision: "human_review",
    stage: "human_review",
    final: false,
    reasonCode,
    reasonSummary,
  };
}

export async function runEventMatcher(
  opts: EventMatcherRunOptions,
): Promise<EventMatcherRunSummary> {
  const startedAt = Date.now();
  const config = getEventMatcherConfig();
  const mode = opts.mode ?? "apply";
  const runId = randomUUID();
  const scopedDecisionIds = [...new Set(opts.decisionIds ?? [])];
  const counters = buildInitialCounters();
  const emit = async (
    phase: EventMatcherProgressPhase,
    message: string,
    details?: Partial<EventMatcherProgressEvent>,
  ) => {
    if (!opts.onProgress) return;
    await opts.onProgress({
      runId,
      mode,
      phase,
      message,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      counters: { ...counters },
      ...details,
    });
  };

  await emit("initializing", "Starting matcher run");

  let snapshotCount = 0;
  let candidateCount = 0;
  let generatedCandidateCount = 0;
  let skippedCandidateCount = 0;
  let autoMerged = 0;
  let autoRejected = 0;
  let deepseekReviewed = 0;
  let humanReview = 0;

  try {
    await emit(
      "loading_snapshots",
      scopedDecisionIds.length > 0
        ? `Loading ${scopedDecisionIds.length.toLocaleString()} selected matcher rows`
        : "Loading provider snapshots",
    );
    const snapshots =
      scopedDecisionIds.length > 0
        ? await loadSnapshotsForDecisionIds(scopedDecisionIds)
        : await loadRecentSnapshots({
            fetchBatchId: opts.fetchBatchId,
          });
    snapshotCount = snapshots.length;
    counters.snapshots = snapshotCount;
    await emit(
      "generating_candidates",
      `Loaded ${snapshotCount.toLocaleString()} snapshots. Building cross-provider pairs`,
    );
    const candidates = generateCandidates(snapshots, config, runId);
    generatedCandidateCount = candidates.length;
    counters.generatedCandidates = generatedCandidateCount;
    if (scopedDecisionIds.length > 0) {
      const staleSuperseded = await supersedeStaleHumanReviewDecisions({
        decisionIds: scopedDecisionIds,
        runId,
        generatedCandidateKeys: new Set(
          candidates.map((candidate) => candidate.candidateKey),
        ),
      });
      if (staleSuperseded > 0) {
        autoRejected += staleSuperseded;
        counters.autoRejected = autoRejected;
        await emit(
          "filtering_candidates",
          `${staleSuperseded.toLocaleString()} stale review rows no longer regenerated as candidates and were superseded`,
        );
      }
    }
    await emit(
      "filtering_candidates",
      `Generated ${generatedCandidateCount.toLocaleString()} candidate pairs. Removing pairs already scored`,
    );
    const newCandidateKeys = await filterNewCandidateKeys(
      candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        shapeFingerprint: candidate.shapeFingerprint,
      })),
      { includeExisting: scopedDecisionIds.length > 0 },
    );
    const seenCandidateKeys = new Set<string>();
    const candidatesToScore = candidates.filter((candidate) => {
      if (!newCandidateKeys.has(candidate.candidateKey)) return false;
      if (seenCandidateKeys.has(candidate.candidateKey)) return false;
      seenCandidateKeys.add(candidate.candidateKey);
      return true;
    });
    candidateCount = candidatesToScore.length;
    skippedCandidateCount = generatedCandidateCount - candidateCount;
    counters.candidatesToScore = candidateCount;
    counters.skippedCandidates = skippedCandidateCount;
    await emit(
      "scoring_candidates",
      `${candidateCount.toLocaleString()} new pairs queued, ${skippedCandidateCount.toLocaleString()} skipped`,
    );

    for (const candidate of candidatesToScore) {
      await emit("scoring_candidates", "Scoring candidate pair", {
        candidate: candidateProgress(candidate),
      });
      const score = await scoreCandidate(candidate, config);
      counters.scoredCandidates++;
      const inserted = await insertCandidate(candidate, score);
      if (!inserted) {
        await emit(
          "scoring_candidates",
          "Candidate already existed before insert",
          {
            candidate: candidateProgress(candidate),
            score: scoreProgress(score),
          },
        );
        continue;
      }
      counters.insertedCandidates++;
      let policy = decideCandidate(candidate.hardBlockers, score, config);

      if (policy.stage === "deepseek") {
        const reviewEnabled = opts.useDeepSeek ?? true;
        if (reviewEnabled) {
          deepseekReviewed++;
          counters.deepseekReviewed = deepseekReviewed;
          await emit(
            "reviewing_residual",
            "Reviewing ambiguous pair with DeepSeek",
            {
              candidate: candidateProgress(candidate),
              score: scoreProgress(score),
            },
          );
          const canonicalMembership = await planCanonicalMerge(candidate);
          const residual = await reviewResidualWithDeepSeek(
            candidate,
            score,
            canonicalMembership,
          );
          policy = policyFromDeepSeek(
            residual,
            candidate.hardBlockers,
            score,
            config,
          );
        } else {
          const skipReason =
            !reviewEnabled && opts.groundedReviewSkipReason === "degraded"
              ? "degraded"
              : "disabled";
          const degradationReason =
            skipReason === "degraded"
              ? (opts.groundedReviewDegradationReason ?? null)
              : null;
          policy = groundedReviewSkipPolicy(
            policy,
            skipReason,
            degradationReason,
          );
        }
      }

      let mergePlan = null;
      let compatibleClusterMergePlan = null;
      if (policy.decision === "auto_merge") {
        mergePlan = await planCanonicalMerge(candidate);
        if (mergePlan.action === "conflict") {
          compatibleClusterMergePlan =
            await planCompatibleCanonicalClusterMerge({
              conflictCanonicalEventIds: mergePlan.conflictCanonicalEventIds,
              score,
            });
          if (compatibleClusterMergePlan.action === "merge") {
            const confidence = Math.max(policy.confidence, score.combined);
            policy = {
              decision: "auto_merge",
              stage: policy.stage,
              confidence,
              confidenceBand: confidenceBand(confidence),
              final: true,
              reasonCode: "compatible_canonical_clusters_merged",
              reasonSummary: compatibleClusterMergePlan.reason,
              groundedDecision: policy.groundedDecision,
              groundedConfidence: policy.groundedConfidence,
            };
          } else {
            policy = {
              decision: "human_review",
              stage: "human_review",
              confidence: policy.confidence,
              confidenceBand: policy.confidenceBand,
              final: false,
              reasonCode: "cluster_conflict",
              reasonSummary: `Canonical cluster conflict: ${mergePlan.conflictCanonicalEventIds.join(", ")}. ${compatibleClusterMergePlan.reason}`,
            };
          }
        }
      }

      await emit("writing_decision", "Writing matcher decision", {
        candidate: candidateProgress(candidate),
        score: scoreProgress(score),
        decision: {
          value: policy.decision,
          stage: policy.stage,
          confidence: policy.confidence,
          reason: policy.reasonSummary,
        },
      });
      const decision = await insertDecision({
        candidate,
        policy,
        score,
      });

      if (policy.decision === "auto_merge") {
        autoMerged++;
        counters.autoMerged = autoMerged;
        if (opts.applyMerges === true) {
          await emit(
            "applying_merge",
            compatibleClusterMergePlan?.action === "merge"
              ? "Merging compatible canonical clusters"
              : "Applying canonical event merge",
            {
              candidate: candidateProgress(candidate),
              score: scoreProgress(score),
              decision: {
                value: policy.decision,
                stage: policy.stage,
                confidence: policy.confidence,
                reason: policy.reasonSummary,
              },
            },
          );
          if (compatibleClusterMergePlan?.action === "merge") {
            await applyCompatibleCanonicalClusterMerge({
              decision,
              plan: compatibleClusterMergePlan,
            });
          } else {
            await applyCanonicalMerge({ candidate, decision });
          }
        }
      } else if (policy.decision === "auto_reject") {
        autoRejected++;
        counters.autoRejected = autoRejected;
      } else {
        humanReview++;
        counters.humanReview = humanReview;
      }
    }

    const clusterSuperseded =
      await supersedeClusterResolvedHumanReviewDecisions({ runId });
    if (clusterSuperseded.superseded > 0) {
      autoMerged += clusterSuperseded.superseded;
      humanReview = Math.max(
        0,
        humanReview - clusterSuperseded.currentRunSuperseded,
      );
      counters.autoMerged = autoMerged;
      counters.humanReview = humanReview;
      await emit(
        "filtering_candidates",
        `${clusterSuperseded.superseded.toLocaleString()} review rows already resolved by canonical clusters were superseded`,
      );
    }

    await emit("rebuilding_impact", "Rebuilding matcher impact rollups");
    await rebuildImpactForRun(runId);
    const summary: EventMatcherRunSummary = {
      id: runId,
      mode,
      status: "completed",
      snapshotCount,
      candidateCount,
      generatedCandidateCount,
      skippedCandidateCount,
      autoMerged,
      autoRejected,
      deepseekReviewed,
      humanReview,
      durationMs: Date.now() - startedAt,
    };
    await emit("completed", "Matcher run complete", { summary });
    return summary;
  } catch (err) {
    const summary: EventMatcherRunSummary = {
      id: runId,
      mode,
      status: "failed",
      snapshotCount,
      candidateCount,
      generatedCandidateCount,
      skippedCandidateCount,
      autoMerged,
      autoRejected,
      deepseekReviewed,
      humanReview,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
    await emit("failed", "Matcher run failed", {
      errorMessage: summary.errorMessage,
      summary,
    });
    return summary;
  }
}
