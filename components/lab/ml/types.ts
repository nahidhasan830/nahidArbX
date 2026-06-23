
export interface PipelineData {
  generatedAtMs: number;
  dataCollection: {
    totalBets: number;
    betsWithFeatures: number;
    settledWithFeatures: number;
    qualifiedForTraining: number;
    canonicalExamples: number;
    uncoveredQualifiedBets: number;
    coldStartThreshold: number;
    coldStartProgress: number;
    featureExtractionHealthy: boolean;
    recentFeatureRate: number;
    currentCorpus: CurrentCorpusSummary;
  };
  training: {
    totalModels: number;
    deployedModel: Record<string, unknown> | null;
    latestModel: Record<string, unknown> | null;
    modelsInTraining: number;
    readyToRetrain: boolean;
    newDataSinceLastTrain: number;
    examplesUntilRetrain: number;
    retrainStep: number;
    activeTraining: {
      modelId: string;
      version: number;
      status: string;
      trainingStage: string | null;
      progressMessage: string | null;
      lastHeartbeatAt: string | null;
      estimatedRemainingMs: number | null;
      sampleCount: number;
      startedAt: string;
      elapsedMs: number | null;
    } | null;
  };
  inference: {
    modelLoaded: boolean;
    modelVersion: number | null;
    totalScoringAttempts: number;
    totalScored: number;
    avgInferenceMs: number;
  };
  scheduler: {
    active: boolean;
    lastTickAt: number | null;
    lastError: string | null;
    totalRetrainTriggers: number;
    retrainStep: number;
  };
  deploymentGate: {
    permissionLevel: string;
    policyEdgeThresholdPct: number;
    modelVersion: number | null;
    canGate: boolean;
    canReduceStake: boolean;
    canIncreaseStake: boolean;
    lastRefreshedAt: string | null;
  };
  scoringMode: string;
  featureContract: {
    currentVersion: number;
    currentFeatureCount: number;
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
    recentTierHealth?: {
      windowHours: number;
      betsWithFeatures: number;
      betsWithValidTier: number;
      validTierPct: number | null;
      healthy: boolean;
    };
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
    mlModelEdgeThresholdPct: number;
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
    trainingStartedAt: string | null;
    trainingCompletedAt: string | null;
    trainingStage: string | null;
    progressMessage: string | null;
    lastHeartbeatAt: string | null;
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

export interface CurrentCorpusDailyHistoryRow {
  day: string;
  totalSettled: number;
  currentContractFeatures: number;
  wins: number;
  losses: number;
}

export interface CurrentCorpusSummary {
  totalSettled: number;
  currentContractFeatures: number;
  wins: number;
  losses: number;
  coldStartThreshold: number;
  collectionTarget: number;
  remainingToColdStart: number;
  remainingToTarget: number;
  dailyTrend?: CurrentCorpusDailyHistoryRow[];
  dailyHistory?: CurrentCorpusDailyHistoryRow[];
}
