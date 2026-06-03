/**
 * Notification layer — generic so we can fan out to multiple channels
 * (Telegram, Slack, email, dashboard SSE) via a single call.
 *
 * All event types are strongly typed so a new consumer can pattern-match
 * exhaustively without string drift.
 */

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

/**
 * Fired when a LightGBM training run starts (Cloud Run Job triggered).
 */
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
  /** Feature version (should be 2). */
  featureVersion: number;
  /** Feature dimensions (should be 25). */
  featureCount: number;
  /** Trigger source: "manual" (dashboard button) or "auto" (+200 new training examples since last deploy or drift retrain). */
  trigger: "manual" | "auto";
  /** Git SHA of the training image (if available). */
  gitSha?: string;
  /** Previous deployed model version (for growth comparison). */
  previousModelVersion?: number;
  /** Previous deployed model's training sample count. */
  previousModelSamples?: number;
}

/**
 * Fired when a LightGBM training run finishes — deployed, rejected, or failed.
 */
export interface MlTrainingCompletedEvent {
  type: "ml:training_completed";
  at: string;
  modelId: string;
  version: number;
  /** Final outcome. */
  outcome: "deployed" | "rejected" | "failed";
  /** Permission level granted (only for deployed). */
  permissionLevel?: string;
  /** Training duration in ms. */
  durationMs: number;
  /** Number of training samples used. */
  trainingSamples: number;
  /** OOS AUC-ROC score. */
  aucRoc?: number;
  /** Deflated Sharpe Ratio. */
  dsr?: number;
  /** Probability of Backtest Overfitting. */
  pbo?: number;
  /** Rejection reasons (for rejected/failed). */
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
  at: string; // ISO
  provider: string;
  providerDisplayName: string;
  eventName: string;
  competition?: string | null;
  sport?: string | null;
  /** ISO kickoff time — lets us show "kicks off in 2h 15m". */
  eventStartTime?: string | null;
  marketName: string;
  selectionName: string;
  stake: number;
  odds: number;
  currency: string;
  mode: "auto" | "manual";
  evPct?: number;
  kellyStake?: number;
  /** Kelly fraction applied (e.g. 0.25 for quarter-Kelly). Optional. */
  kellyFraction?: number;
  /** Time scope of the market — FT/HT/T1/T2/P1/P2/OT. Optional. */
  timeScope?: string | null;
  /** Line for handicap/total markets (e.g. "-1.25", "2.5"). Optional. */
  familyLine?: string | null;
  ticketId?: string;
  /** Deep-link back to this bet in the app dashboard. */
  dashboardUrl?: string;
  /** Remaining provider balance after placement. */
  balance?: number;
}

export type BetOutcome = "won" | "lost" | "void" | "half_won" | "half_lost";

/**
 * Final score snapshot. Mirrors `match_scores` but intentionally
 * transport-only (no DB types leaking into the notifier). `status`
 * distinguishes regular time from extra-time / penalty shootouts so
 * the formatter can tag the scoreline correctly.
 */
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
  /** Closing line (for CLV% display). */
  closingOdds?: number | null;
  /** Placement time (ISO) — used to show "held for 3h". */
  placedAt?: string | null;
  currency: string;
  outcome: BetOutcome;
  pnl: number;
  settledBySource?: string;
  /** Final score + status. When set the formatter surfaces the result
   *  as the first contextual line inside the details block. */
  matchScore?: MatchScoreInfo | null;
  /** Time scope of the market — FT/HT/T1/T2/P1/P2/OT. Optional. */
  timeScope?: string | null;
  /** Line for handicap/total markets. Optional. */
  familyLine?: string | null;
  /** Deep-link back to this bet in the app dashboard. */
  dashboardUrl?: string;
  /** Remaining provider balance after settlement payout. */
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
  /** ISO kickoff time — lets the formatter surface "kicks off in 2h". */
  eventStartTime?: string | null;
  marketName: string;
  selectionName: string;
  /** Time scope of the market — FT/HT/T1/T2/P1/P2/OT. Optional. */
  timeScope?: string | null;
  /** Line for handicap/total markets (e.g. "-1.25", "2.5"). Optional. */
  familyLine?: string | null;
  error: string;
  /**
   * Bucketed reason — lets the formatter pick an icon / copy without
   * string-matching the raw book response, and gives ops a stable
   * dimension to aggregate failures in dashboards.
   */
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
  /** Auto-detected edge vs operator-clicked. Surfaced in the error ping
   *  so the operator can tell whether a failure came from the scheduler
   *  or from a manual click. */
  mode?: "auto" | "manual";
  /** What we asked the book to accept. Nullable — validation failures
   *  happen before sizing is resolved. */
  stake?: number;
  odds?: number;
  currency?: string;
  /** Edge (EV%) the detector saw for this selection — the reason we
   *  attempted in the first place. */
  evPct?: number;
  /** Kelly fraction applied (e.g. 0.25 for quarter-Kelly). Optional. */
  kellyFraction?: number;
  /** Book minimum / maximum at the time of the attempt. Nullable when
   *  the placer didn't get as far as fetching limits. */
  minBet?: number;
  maxBet?: number | null;
  balance?: number;
  /** Deep-link back to this bet in the app dashboard. */
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

/**
 * Fired once on server boot. Carries structured context so the
 * formatter can render a clean one-fact-per-line card instead of
 * cramming everything into a single SystemEvent message string.
 */
export interface SystemBootEvent {
  type: "system:boot";
  at: string;
  /** Which process is booting — "engine" or "frontend". */
  process: "engine" | "frontend";
  /** Node.js runtime version. */
  nodeVersion: string;
  /** Environment label — "development" or "production". */
  env: string;
  /** PID of the process. */
  pid?: number;
  /** Engine HTTP API port (engine only). */
  enginePort?: number;
  /** Sync scheduler running? (engine only). */
  syncScheduler?: boolean;
  /** Auto-settle running? (engine only). */
  autoSettle?: boolean;
  /** Auto-settle interval (seconds). (engine only). */
  autoSettleIntervalSec?: number;
  /** Per-provider auto-place state. (engine only). */
  autoPlace?: { provider: string; displayName: string; enabled: boolean }[];
  /** Real-time data sources (engine only). */
  dataSources?: string[];
  /** Reactive detector debounce (ms). (engine only). */
  detectorDebounceMs?: number;
  /** ML retraining Cloud Run Job name (if set). (engine only). */
  mlRetrainJob?: string | null;
  /** GCP region (if set). (engine only). */
  mlRetrainRegion?: string | null;
  /** Engine URL that frontend connects to (frontend only). */
  engineUrl?: string;
  /** Whether the frontend can reach the engine (frontend only). */
  engineReachable?: boolean;
}

/**
 * Fired when `dev:all` (unified boot) gathers all process boot payloads
 * into a single consolidated notification. Contains optional sub-sections
 * for each service that successfully wrote its boot payload.
 */
export interface UnifiedBootEvent {
  type: "system:unified_boot";
  at: string;
  engine?: SystemBootEvent;
  aiSearch?: AiEngineStateEvent;
  frontend?: SystemBootEvent;
}

/**
 * Contract every notification channel implements. A channel can choose to
 * ignore event types it doesn't care about.
 */
export interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent): Promise<void>;
}
