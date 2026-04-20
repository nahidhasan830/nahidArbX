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
  | SystemEvent;

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
 * Contract every notification channel implements. A channel can choose to
 * ignore event types it doesn't care about.
 */
export interface NotificationChannel {
  readonly id: string;
  send(event: NotificationEvent): Promise<void>;
}
