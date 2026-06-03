export { getEventMatcherConfig } from "./config";
export { generateCandidates, hardBlockersForCandidate } from "./candidates";
export { decideCandidate, confidenceBand } from "./policy";
export { scoreCandidate } from "./scoring";
export { runEventMatcher } from "./run";
export {
  enqueueEventMatcherRunJob,
  readEventMatcherRunJob,
  readLatestEventMatcherRunJob,
  startEventMatcherRunJob,
} from "./jobs";
export {
  captureProviderSnapshots,
  snapshotIdFor,
  toSnapshotInput,
} from "./snapshots";
export {
  countDecisionRows,
  countDecisions,
  decisionCountsForDecisionRows,
  decisionCountsByDecision,
  listDecisionRows,
  markManualDecision,
  planCanonicalMerge,
  readCanonicalClusters,
  readDecisionRow,
  readImpact,
  readReliabilityStats,
  supersedeClusterResolvedHumanReviewDecisions,
} from "./repository";
export type {
  EventMatcherConfig,
  EventMatcherClusterSummary,
  EventMatcherReliabilityStats,
  EventMatcherRunOptions,
  EventMatcherRunSummary,
  EventMatcherProgressEvent,
  ProviderEventSnapshot,
  ProviderSnapshotInput,
  ScoreBreakdown,
} from "./types";
export type { EventMatcherRunJob, EventMatcherJobStatus } from "./jobs";
