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
  | OptimizerRunStartedEvent
  | OptimizerRunCompletedEvent
  | MlRunCompletedEvent;

export interface MlRunCompletedEvent {
  type: "ml:run_completed";
  at: string;
  processed: number;
  merged: number;
  rejected: number;
  escalated: number;
  durationMs: number;
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
  /** Pre-built Google AI Mode grade URL, rendered as a tap-through link. */
  gradeUrl?: string;
  /** Deep-link back to this bet in the app dashboard. */
  dashboardUrl?: string;
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
  /** Pre-built Google AI Mode grade URL, rendered as a tap-through link. */
  gradeUrl?: string;
  /** Deep-link back to this bet in the app dashboard. */
  dashboardUrl?: string;
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

/**
 * Fired once when the sidecar picks an Optimisation run up (status transitions
 * from `queued → running`). Emitted by the notifier tick on a ~10s cadence;
 * the tick stamps `optimization_runs.started_notified_at` for at-most-once
 * delivery.
 *
 * Payload is the full heads-up package the operator needs to decide whether
 * to expect a quick sweep or a long overnight run: name + id, algorithm,
 * trial count, CV strategy, expected finish time (p50 of historical
 * durations for the same shape), bet count surviving the data-scope filter,
 * and a one-line scope summary (date range + soft books + markets).
 */
export interface OptimizerRunStartedEvent {
  type: "optimizer:run_started";
  at: string; // ISO — time of emission (= close to started_notified_at)
  runId: string;
  name: string;
  searchAlgorithm: string; // "ensemble" | "tpe" | "nsga2" | "random" | "ml-xgboost"
  rngSeed: number;
  nTrialsTarget: number;
  /** CV strategy label — e.g. "CPCV-10 (embargo 5)" or "Walk-forward (3 windows)". */
  cvStrategyLabel: string;
  startedAt: string; // ISO

  /** Bet count that survived the pre-search data-scope filter. */
  betCount: number | null;
  /** One-line human-readable summary — date range + providers + markets. */
  scopeSummary: string;

  /** Historical p50-based estimate of seconds to finish. Null if we've
   *  never run something like this before — the formatter then omits the ETA
   *  line rather than guessing wildly. */
  estimatedDurationSec: number | null;
  /** String describing how the ETA was derived — "p50 of 12 prior runs" or
   *  "heuristic (no prior data)" — for transparency. */
  estimationBasis: string | null;
  /** ISO of the expected finish time (started_at + estimatedDurationSec).
   *  Null when estimatedDurationSec is null. */
  estimatedFinishAt: string | null;

  /** "manual" | `schedule:<schedule_id>`. Copies `created_by` verbatim. */
  createdBy: string;
  /** Deep-link to /lab/optimisation/<runId>. */
  dashboardUrl?: string;
}

/**
 * Fired once when an Optimisation optimizer run transitions to a terminal
 * status (`completed | failed | cancelled`). Emitted by the notifier tick
 * (lib/optimizer/notifier-tick.ts) on a ~10s cadence; the tick stamps
 * `optimization_runs.notified_at` to guarantee at-most-once delivery.
 *
 * The formatter (lib/notifier/telegram.ts) renders this in the repo's strict
 * one-fact-per-line style with signed percentages so the operator can scan
 * a run's outcome from the notification without opening the app.
 */
export interface OptimizerRunCompletedEvent {
  type: "optimizer:run_completed";
  at: string; // ISO — time of emission (= close to notified_at)
  runId: string;
  name: string;
  status: "completed" | "failed" | "cancelled";
  searchAlgorithm: string; // "ensemble" | "tpe" | "nsga2" | "random" | "ml-xgboost"
  startedAt: string | null;
  completedAt: string;
  durationSec: number;
  nTrialsDone: number;
  nTrialsTarget: number;
  /** Populated for completed runs from the sidecar's summary JSON. */
  nPareto?: number | null;
  bestComposite?: number | null;
  /** Best-trial metrics — null on failure / no trials completed. */
  best?: {
    trialId: string;
    trialIndex?: number | null;
    roiPct: number | null;
    roiCiLow: number | null;
    roiCiHigh: number | null;
    sharpe: number | null;
    sortino: number | null;
    maxDrawdownPct: number | null;
    deflatedSharpe: number | null;
    probabilisticSharpe: number | null;
    sampleSize: number | null;
  } | null;
  /** "manual" | `schedule:<schedule_id>`. Copies `created_by` verbatim. */
  createdBy: string;
  error?: string | null;
  /** Deep-link to /lab/optimisation/<runId>. */
  dashboardUrl?: string;
  /** Deep-link to the best trial inside the run detail page. */
  topTrialUrl?: string;
}

/**
 * Contract every notification channel implements. A channel can choose to
 * ignore event types it doesn't care about.
 */
export interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent): Promise<void>;
}
