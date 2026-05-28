export type LearningVerdict =
  | "learning"
  | "not_enough_settled_evidence"
  | "not_beating_baseline"
  | "calibration_weak"
  | "overfit_risk"
  | "feature_drift"
  | "settlement_lag";

export type LearningMetric = {
  label: string;
  sampleSize: number;
  roiPct: number | null;
  winRatePct: number | null;
  avgEvPct: number | null;
  avgModelEdgePct: number | null;
  avgClvPct: number | null;
};

export type LearningScoreBucket = {
  bucket: string;
  low: number;
  high: number;
  count: number;
  roiPct: number | null;
  winRatePct: number | null;
  avgScore: number | null;
  avgModelEdgePct: number | null;
  avgClvPct: number | null;
};

export type LearningCalibrationBucket = {
  bucket: string;
  low: number;
  high: number;
  count: number;
  predictedPct: number | null;
  actualPct: number | null;
  gapPct: number | null;
};

export type LearningModelHistoryRow = {
  version: number;
  status: string;
  trainingSamples: number;
  oosAucRoc: number | null;
  oosLogLoss: number | null;
  calibrationError: number | null;
  deflatedSharpe: number | null;
  pbo: number | null;
  policyRoiMean: number | null;
  simplePolicyRoiMean: number | null;
  modelVsSimpleRoiDelta: number | null;
  policySampleSize: number | null;
  permissionLevel: string | null;
  createdAt: string | null;
  deployedAt: string | null;
};

export type LearningFeatureImportance = {
  feature: string;
  importance: number;
  rank: number;
};

export type LearningSnapshotMetrics = {
  generatedAt: string;
  dataAsOf: string;
  latestSettledAt: string | null;
  latestScoredAt: string | null;
  selectedModelVersion: number | null;
  counts: {
    scoredPredictions: number;
    settledPredictions: number;
    pendingPredictions: number;
    mlGateSettled: number;
    simpleRuleSettled: number;
    placedSettled: number;
    currentContractExamples: number;
    excludedContractPredictions: number;
  };
  cohorts: {
    detectedBaseline: LearningMetric;
    simpleEvCore: LearningMetric;
    mlScored: LearningMetric;
    mlGate: LearningMetric;
    placed: LearningMetric;
  };
  verdict: {
    code: LearningVerdict;
    label: string;
    reason: string;
    confidence: "low" | "medium" | "high";
    blockers: string[];
  };
  quality: {
    roiLiftPct: number | null;
    calibrationError: number | null;
    brierScore: number | null;
    logLoss: number | null;
    aucRoc: number | null;
    scoreMonotonicity: number | null;
    overfitRisk: "low" | "medium" | "high" | "unknown";
    settlementLagPct: number;
  };
  scoreBuckets: LearningScoreBucket[];
  calibrationBuckets: LearningCalibrationBucket[];
  modelHistory: LearningModelHistoryRow[];
  featureImportance: LearningFeatureImportance[];
  notes: string[];
};

export type LearningSnapshotResponse = {
  id: number;
  snapshotHash: string;
  modelVersion: number | null;
  verdict: LearningVerdict;
  verdictReason: string;
  trigger: string;
  dataAsOf: string;
  createdAt: string;
  settledPredictionCount: number;
  pendingPredictionCount: number;
  scoredPredictionCount: number;
  baselineRoiPct: number | null;
  simpleRoiPct: number | null;
  mlGateRoiPct: number | null;
  roiLiftPct: number | null;
  calibrationError: number | null;
  brierScore: number | null;
  logLoss: number | null;
  aucRoc: number | null;
  scoreMonotonicity: number | null;
  metrics: LearningSnapshotMetrics;
};

export type LearningExplanationContent = {
  summary: string;
  verdict: string;
  whatImproved: string[];
  whatRegressed: string[];
  risks: string[];
  nextActions: string[];
  mentalModel: string;
};

export type LearningExplanationResponse = {
  id: number;
  snapshotHash: string;
  explanationType: string;
  provider: string;
  model: string;
  status: string;
  summary: string | null;
  content: LearningExplanationContent;
  promptHash: string;
  generatedAt: string;
  createdAt: string;
};
