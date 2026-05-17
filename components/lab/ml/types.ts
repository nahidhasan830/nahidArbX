/**
 * Shared types for the ML dashboard components.
 */

export interface PipelineData {
  dataCollection: {
    totalBets: number;
    betsWithFeatures: number;
    settledWithFeatures: number;
    qualifiedForTraining: number;
    coldStartThreshold: number;
    coldStartProgress: number;
    featureExtractionHealthy: boolean;
    recentFeatureRate: number;
  };
  training: {
    totalModels: number;
    deployedModel: Record<string, unknown> | null;
    latestModel: Record<string, unknown> | null;
    modelsInTraining: number;
    readyToRetrain: boolean;
    newDataSinceLastTrain: number;
    growthPct: number;
    activeTraining: {
      modelId: string;
      version: number;
      status: string;
      startedAt: string;
      elapsedMs: number | null;
    } | null;
  };
  inference: {
    modelLoaded: boolean;
    modelVersion: number | null;
    totalScored: number;
    avgInferenceMs: number;
    error?: string;
  };
  scheduler: {
    active: boolean;
    lastTickAt: number | null;
    totalRetrainTriggers: number;
    lastError: string | null;
    /** Auto-retrain growth threshold (e.g. 20 = "≥20% corpus growth"). */
    growthThresholdPct: number;
  };
  deploymentGate: {
    permissionLevel: string;
    modelVersion: number | null;
    canGate: boolean;
    canReduceStake: boolean;
    canIncreaseStake: boolean;
    lastRefreshedAt: string | null;
  };
  scoringMode: string;
  scoreDistribution: {
    buckets: { range: string; count: number }[];
    avgScore: number;
    belowThreshold: number;
    aboveThreshold: number;
    totalScored: number;
  };
  featureContract: {
    currentVersion: number;
    currentFeatureCount: number;
    currentNamesHash: string;
    versionDistribution: { version: number | null; count: number }[];
    lengthDistribution: { length: number | null; count: number }[];
    allVersionsMatch: boolean;
    allLengthsMatch: boolean;
    semanticChecks: {
      betsWithCurrentFeatures: number;
      badCompetitionTier: number;
      trainableSettledCurrentFeatures: number;
      badTrainableCompetitionTier: number;
      labeledExamples: number;
      badLabeledCompetitionTier: number;
      cleanLabeledExamples: number;
      badLabeledNonPositiveEv: number;
      semanticPass: boolean;
    };
    allSemanticChecksPass: boolean;
  };
  enrichmentCoverage: {
    distinctCompetitions: number;
    enrichedCompetitions: number;
    highConfidence: number;
    coveragePct: number;
  };
  trainingComposition: {
    byType: Record<string, number>;
    byLabel: Record<string, number>;
    totalExamples: number;
  };
  scoreBucketROI: {
    bucket: string;
    count: number;
    avgPnl: number;
    avgClv: number;
    winRate: number;
    avgEdge?: number | null;
  }[];
  paperEvaluation: {
    semanticHealth: {
      betsWithCurrentFeatures: number;
      badCompetitionTier: number;
      trainableSettledCurrentFeatures: number;
      badTrainableCompetitionTier: number;
      labeledExamples: number;
      badLabeledCompetitionTier: number;
      cleanLabeledExamples: number;
      badLabeledNonPositiveEv: number;
      semanticPass: boolean;
    };
    simpleRule: {
      minEvPct: number;
      marketTypes: string[];
    };
    mlMinScore: number;
    metrics: {
      detectedBaseline: PaperEvaluationMetric;
      simpleEvCore: PaperEvaluationMetric;
      mlScored: PaperEvaluationMetric;
      mlGate: PaperEvaluationMetric;
    };
    verdict: {
      enoughMlGateSamples: boolean;
      mlBeatsSimpleRule: boolean;
      mlMinusSimpleRoiPct: number | null;
    };
    trend: {
      day: string;
      baselineN: number;
      baselineRoiPct: number | null;
      simpleN: number;
      simpleRoiPct: number | null;
      mlGateN: number;
      mlGateRoiPct: number | null;
    }[];
  };
  rejectedModels: {
    version: number;
    status: string;
    reasons: string[];
    createdAt: string | null;
    trainingSamples: number;
    oosAucRoc: number | null;
    deflatedSharpe: number | null;
    pbo: number | null;
  }[];
  modelHistory: {
    version: number;
    status: string;
    trainingSamples: number;
    oosAucRoc: number | null;
    deflatedSharpe: number | null;
    pbo: number | null;
    permissionLevel: string | null;
    rejectionReasons: string[] | null;
    deployedAt: string | null;
    createdAt: string | null;
  }[];
}

export interface PaperEvaluationMetric {
  label: string;
  sampleSize: number;
  roiPct: number | null;
  winRatePct: number | null;
  avgEvPct: number | null;
  avgOdds: number | null;
}

export type StageStatus =
  | "healthy"
  | "action"
  | "progressing"
  | "waiting"
  | "warning";
