
export type NotificationEvent =
  | BetPlacedEvent
  | BetSettledEvent
  | BetErrorEvent
  | SystemEvent
  | SystemBootEvent
  | UnifiedBootEvent
  | ProviderHealthEvent
  | AiEngineStateEvent
  | AiModelStateEvent
  | MlRunCompletedEvent
  | MlTrainingStartedEvent
  | MlTrainingCompletedEvent;

export interface MlRunCompletedEvent {
  type: "ml:run_completed";
  at: string;
  processed: number;
  generated?: number;
  skipped?: number;
  merged: number;
  rejected: number;
  escalated: number;
  durationMs: number;
}

export interface MlTrainingStartedEvent {
  type: "ml:training_started";
  at: string;
  modelId: string;
  version: number;
  qualifiedBets: number;
  rawLabeledExamples: number;
  canonicalExamples: number;
  uncoveredQualifiedBets: number;
  trainerExpectedSamples: number;
  featureVersion: number;
  featureCount: number;
  trigger: "manual" | "auto";
  gitSha?: string;
  previousModelVersion?: number;
  previousModelSamples?: number;
}

export interface MlTrainingCompletedEvent {
  type: "ml:training_completed";
  at: string;
  modelId: string;
  version: number;
  outcome: "deployed" | "rejected" | "failed";
  permissionLevel?: string;
  durationMs: number;
  trainingSamples: number;
  aucRoc?: number;
  dsr?: number;
  pbo?: number;
  rejectionReasons?: string[];
}

export interface AiEngineStateEvent {
  type: "ai:engine_state";
  at: string;
  state: "started" | "stopped" | "failed";
  serviceUrl: string;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  uptimeMs?: number | null;
  configuredModel: string;
  llmEngine: string;
  llmHealthy?: boolean;
  providersHealthy?: number;
  providersTotal?: number;
  reason?: string | null;
}

export interface AiModelStateEvent {
  type: "ai:model_state";
  at: string;
  state: "on" | "off";
  model: string;
  configuredModel: string;
  llmEngine: string;
  reason?: string | null;
}

export interface BetPlacedEvent {
  type: "bet:placed";
  at: string;
  provider: string;
  providerDisplayName: string;
  eventName: string;
  competition?: string | null;
  sport?: string | null;
  eventStartTime?: string | null;
  marketName: string;
  selectionName: string;
  stake: number;
  odds: number;
  currency: string;
  mode: "auto" | "manual";
  evPct?: number;
  kellyStake?: number;
  kellyFraction?: number;
  timeScope?: string | null;
  familyLine?: string | null;
  ticketId?: string;
  dashboardUrl?: string;
  balance?: number;
}

export type BetOutcome = "won" | "lost" | "void" | "half_won" | "half_lost";

export interface MatchScoreInfo {
  status: "FT" | "AET" | "PEN" | "ABD" | "POSTPONED";
  ftHome: number;
  ftAway: number;
  htHome?: number | null;
  htAway?: number | null;
  etHome?: number | null;
  etAway?: number | null;
  penHome?: number | null;
  penAway?: number | null;
}

export interface BetSettledEvent {
  type: "bet:settled";
  at: string;
  provider: string;
  providerDisplayName: string;
  eventName: string;
  competition?: string | null;
  sport?: string | null;
  marketName: string;
  selectionName: string;
  stake: number;
  odds: number;
  closingOdds?: number | null;
  placedAt?: string | null;
  currency: string;
  outcome: BetOutcome;
  pnl: number;
  settledBySource?: string;
  matchScore?: MatchScoreInfo | null;
  timeScope?: string | null;
  familyLine?: string | null;
  dashboardUrl?: string;
  balance?: number;
}

export interface BetErrorEvent {
  type: "bet:error";
  at: string;
  provider: string;
  providerDisplayName?: string;
  eventName: string;
  competition?: string | null;
  sport?: string | null;
  eventStartTime?: string | null;
  marketName: string;
  selectionName: string;
  timeScope?: string | null;
  familyLine?: string | null;
  error: string;
  reasonCategory?:
    | "below_market_min"
    | "above_market_max"
    | "above_balance"
    | "suspended"
    | "duplicate"
    | "transport"
    | "adapter_error"
    | "book_rejection"
    | "unknown";
  mode?: "auto" | "manual";
  stake?: number;
  odds?: number;
  currency?: string;
  evPct?: number;
  kellyFraction?: number;
  minBet?: number;
  maxBet?: number | null;
  balance?: number;
  dashboardUrl?: string;
}

export interface SystemEvent {
  type: "system";
  at: string;
  severity: "info" | "warn" | "error";
  message: string;
}

export interface ProviderHealthEvent {
  type: "provider:health";
  at: string;
  state: "down" | "recovered";
  provider: string;
  displayName: string;
  severity?: "degraded" | "down";
  status?: "pending" | "degraded" | "down" | "ok";
  reason: string;
  action: string;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  fingerprint: string;
}

export interface SystemBootEvent {
  type: "system:boot";
  at: string;
  process: "engine" | "frontend";
  nodeVersion: string;
  env: string;
  pid?: number;
  enginePort?: number;
  syncScheduler?: boolean;
  autoSettle?: boolean;
  autoSettleIntervalSec?: number;
  autoPlace?: { provider: string; displayName: string; enabled: boolean }[];
  dataSources?: string[];
  detectorDebounceMs?: number;
  mlRetrainJob?: string | null;
  mlRetrainRegion?: string | null;
  engineUrl?: string;
  engineReachable?: boolean;
}

export interface UnifiedBootEvent {
  type: "system:unified_boot";
  at: string;
  engine?: SystemBootEvent;
  frontend?: SystemBootEvent;
}

export interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent): Promise<void>;
}
