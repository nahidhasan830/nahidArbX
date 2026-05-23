const INPUT_LABELS: Record<string, string> = {
  active: "Scheduler active",
  allLengthsMatch: "Vector lengths match",
  allSemanticChecksPass: "Semantic checks pass",
  allVersionsMatch: "Feature versions match",
  avgInferenceMs: "Average inference time",
  badCompetitionTier: "Bad competition tiers",
  betsWithFeatures: "Bets with features",
  betsWithValidTier: "Bets with valid tier",
  betsWithCurrentFeatures: "Bets with current features",
  canGate: "Can gate bets",
  canIncreaseStake: "Can increase stake",
  canReduceStake: "Can reduce stake",
  candidateModels: "Candidate models",
  canonicalExamples: "Canonical examples",
  coldStartThreshold: "Cold-start threshold",
  currentFeatureCount: "Feature count",
  currentNamesHash: "Feature-name hash",
  currentVersion: "Feature version",
  deployedRows: "Deployed rows",
  deployedVersion: "Deployed version",
  detectedBaseline: "Detected baseline",
  error: "Error",
  examplesUntilRetrain: "Examples until retrain",
  failedRows: "Failed rows",
  healthy: "Healthy",
  lastError: "Last error",
  lastTickAt: "Last scheduler tick",
  lengthDistribution: "Vector lengths",
  mlGate: "ML gate",
  mlMinusSimpleRoiPct: "ML minus simple ROI",
  mlScored: "ML scored",
  modelLoaded: "Model loaded",
  modelVersion: "Model version",
  modelsInTraining: "Models in training",
  newDataSinceLastTrain: "New data since last train",
  permissionLevel: "Permission level",
  policyEdgeThreshold: "Policy edge threshold",
  policyEdgeThresholdPct: "Policy edge threshold",
  qualifiedForTraining: "Qualified for training",
  readyToRetrain: "Ready to retrain",
  recentFeatureRate: "Recent feature rate",
  recentTierHealth: "Recent tier health",
  rejectedReasons: "Rejection reasons",
  rejectedRecent: "Recent rejection",
  rejectedRows: "Rejected rows",
  remainingToColdStart: "Remaining to cold-start",
  retrainStep: "Retrain step",
  settledWithFeatures: "Settled bets with features",
  simpleEvCore: "Simple EV core",
  totalBets: "Total bets",
  totalModelRows: "Total model rows",
  totalRetrainTriggers: "Retrain triggers",
  totalScored: "Scored attempts",
  totalScoringAttempts: "Scoring attempts",
  uncoveredQualifiedBets: "Uncovered qualified bets",
  validTierPct: "Valid tier rate",
  validatedRows: "Validated rows",
  versionDistribution: "Feature versions",
  vertexEndpoint: "Vertex endpoint",
  windowHours: "Window",
};

const PERMISSION_LABELS: Record<string, string> = {
  observe: "Observe only",
  gate_only: "Gate only",
  stake_reduce: "Reduce stake",
  stake_increase: "Adjust stake",
};

const MODEL_STATUS_LABELS: Record<string, string> = {
  deployed: "Deployed",
  failed: "Failed",
  rejected: "Rejected",
  retired: "Retired",
  training: "Training",
  validated: "Validated",
};

const WORD_OVERRIDES: Record<string, string> = {
  ai: "AI",
  api: "API",
  auc: "AUC",
  clv: "CLV",
  db: "DB",
  dsr: "DSR",
  ev: "EV",
  fv: "FV",
  ht: "HT",
  id: "ID",
  ml: "ML",
  pbo: "PBO",
  pnl: "P&L",
  roi: "ROI",
  sql: "SQL",
};

function titleCaseToken(token: string): string {
  const lower = token.toLowerCase();
  return WORD_OVERRIDES[lower] ?? lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(titleCaseToken)
    .join(" ");
}

export function formatRungInputLabel(label: string): string {
  if (INPUT_LABELS[label]) return INPUT_LABELS[label];
  if (label.startsWith("bucket ")) {
    return `Bucket ${label.slice("bucket ".length)}`;
  }
  return humanizeKey(label);
}

export function formatPermissionLevel(level: string | null | undefined): string {
  if (!level) return "Observe only";
  return PERMISSION_LABELS[level] ?? humanizeKey(level);
}

export function formatModelStatus(status: string | null | undefined): string {
  if (!status) return "—";
  return MODEL_STATUS_LABELS[status] ?? humanizeKey(status);
}

export function formatRungInputValue(label: string, value: string): string {
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  if (value === "null" || value === "n/a") return "—";
  if (value === "not exposed") return "Not exposed";
  if (label === "permissionLevel") return formatPermissionLevel(value);
  return value;
}
