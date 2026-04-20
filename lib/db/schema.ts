import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = () => timestamp({ withTimezone: true, mode: "string" });
const tsNow = () => ts().notNull().defaultNow();
const nz4 = () => numeric({ precision: 10, scale: 4, mode: "number" });

export const valueBets = pgTable(
  "value_bets",
  {
    id: text().primaryKey(),
    eventId: text().notNull(),
    familyId: text().notNull(),
    atomId: text().notNull(),
    atomLabel: text().notNull(),

    homeTeam: text().notNull(),
    awayTeam: text().notNull(),
    competition: text(),
    eventStartTime: ts().notNull(),
    matchConfidence: numeric({ precision: 4, scale: 3, mode: "number" }),

    marketType: text().notNull(),
    timeScope: text().notNull(),
    familyLine: numeric({ precision: 5, scale: 2, mode: "number" }),

    sharpProvider: text().notNull(),
    sharpOdds: nz4().notNull(),
    sharpTrueProb: numeric({
      precision: 6,
      scale: 5,
      mode: "number",
    }).notNull(),
    sharpOddsAgeMs: integer(),

    softProvider: text().notNull(),
    softCommissionPct: numeric({
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    softOddsFirst: nz4().notNull(),
    softOddsLast: nz4().notNull(),
    softOddsMax: nz4().notNull(),

    firstSeenAt: ts().notNull(),
    lastSeenAt: ts().notNull(),
    tickCount: integer().notNull().default(1),

    closingSharpOdds: nz4(),
    closingSoftOdds: nz4(),
    closingCapturedAt: ts(),

    outcome: text().notNull().default("pending"),
    outcomeMarkedAt: ts(),
    /**
     * Which part of the settlement pipeline produced this outcome —
     * e.g. 'espn', 'sofascore', 'pinnacle-ws', 'url-context', 'manual'.
     * NULL on rows settled before this column existed. Lets the UI show
     * "Resolved by: SofaScore" durably, and lets us audit which tier
     * contributes what over time.
     */
    settledBySource: text(),
    /**
     * How many times a settlement tick has processed this row. A row
     * with `outcome='pending' AND settle_attempts > 0` is the
     * definition of "needs human review" — pipeline tried, pipeline
     * couldn't resolve it.
     */
    settleAttempts: integer().notNull().default(0),
    lastSettleAttemptAt: ts(),

    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index("value_bets_first_seen_idx").on(t.firstSeenAt.desc()),
    index("value_bets_market_idx").on(t.marketType, t.timeScope),
    index("value_bets_soft_idx").on(t.softProvider),
    index("value_bets_soft_odds_max_idx").on(t.softOddsMax.desc()),
    index("value_bets_outcome_idx")
      .on(t.outcome)
      .where(sql`${t.outcome} <> 'pending'`),
    index("value_bets_event_start_idx").on(t.eventStartTime),
  ],
);

export type ValueBetRow = typeof valueBets.$inferSelect;
export type NewValueBetRow = typeof valueBets.$inferInsert;

export const strategies = pgTable(
  "strategies",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    // Stored as the same shape as ListFilters so the UI can load them back
    // into the toolbar verbatim.
    filters: jsonb().notNull(),
    stakeMultiplier: numeric({
      precision: 6,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(1),
    // "manual" when the user saves filters from the toolbar; "ai" when Gemini
    // proposes a rule. Helps us treat AI-generated ones with more scepticism.
    origin: text().notNull().default("manual"),
    // Optional narrative — user notes OR AI rationale JSON (sources, risks).
    rationale: text(),
    // Lifecycle: candidate → live → paused → retired.
    status: text().notNull().default("candidate"),
    // Snapshot of metrics at the moment the strategy was saved. Lets the
    // strategy list render perf badges without re-running the pivot.
    metricsSnapshot: jsonb(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index("strategies_status_idx").on(t.status),
    index("strategies_origin_idx").on(t.origin),
  ],
);

export type StrategyRow = typeof strategies.$inferSelect;
export type NewStrategyRow = typeof strategies.$inferInsert;

/**
 * Logs every live match of a strategy against a value bet. One row per
 * (strategy, value_bet) pair — unique index prevents double-counting when
 * the same bet is redetected across sync cycles.
 *
 * Reporting (ROI, CLV etc.) is computed by joining back to value_bets —
 * no need to denormalize outcome here.
 */
export const strategyExecutions = pgTable(
  "strategy_executions",
  {
    id: text().primaryKey(),
    strategyId: text().notNull(),
    valueBetId: text().notNull(),
    matchedAt: tsNow(),
    // Snapshot of the strategy's multiplier at match time — if the user edits
    // the strategy later, historical executions still show what they'd have
    // staked originally.
    stakeMultiplier: numeric({
      precision: 6,
      scale: 3,
      mode: "number",
    })
      .notNull()
      .default(1),
  },
  (t) => [
    index("strategy_exec_strategy_idx").on(t.strategyId),
    index("strategy_exec_value_bet_idx").on(t.valueBetId),
    // Idempotency — one execution per (strategy, value_bet).
    index("strategy_exec_unique_idx").on(t.strategyId, t.valueBetId),
  ],
);

export type StrategyExecutionRow = typeof strategyExecutions.$inferSelect;
export type NewStrategyExecutionRow = typeof strategyExecutions.$inferInsert;

/**
 * Settled match scores — permanent cache keyed by normalized eventId.
 *
 * Populated by the settlement waterfall from the cheapest available source
 * that can resolve the final score (live feeds → free APIs → url_context →
 * batched Gemini). Scores are effectively immutable once status='FT', so
 * this doubles as a long-term archive: every re-settlement hits this table
 * first at tier 0 and costs $0.
 */
export const matchScores = pgTable(
  "match_scores",
  {
    eventId: text().primaryKey(),
    status: text().notNull(), // 'FT' | 'AET' | 'PEN' | 'ABD' | 'POSTPONED'
    htHome: integer(),
    htAway: integer(),
    ftHome: integer().notNull(),
    ftAway: integer().notNull(),
    etHome: integer(),
    etAway: integer(),
    penHome: integer(),
    penAway: integer(),
    /**
     * Optional corner counts — only populated when a batch containing a
     * corners-market bet triggered the statistics-capable tier (SofaScore).
     * NULL on events resolved before we added corners support.
     */
    cornersHome: integer(),
    cornersAway: integer(),
    htCornersHome: integer(),
    htCornersAway: integer(),
    source: text().notNull(), // 'pinnacle-ws' | 'betconstruct' | 'football-data' | 'espn' | 'sofascore' | 'openligadb' | 'url-context' | 'gemini-batch' | 'manual'
    confidence: numeric({ precision: 3, scale: 2, mode: "number" }).notNull(),
    sourceUrl: text(),
    fetchedAt: tsNow(),
  },
  (t) => [index("match_scores_status_idx").on(t.status)],
);

export type MatchScoreRow = typeof matchScores.$inferSelect;
export type NewMatchScoreRow = typeof matchScores.$inferInsert;

/**
 * Per-tick telemetry from the auto-settle scheduler. Lets us chart cost,
 * tier-hit distribution, and failure rates over time without rummaging
 * through log files. Rows accumulate cheaply (one per interval) and are
 * capped by an ON DELETE RETENTION script if they ever grow too large.
 */
export const settlementRuns = pgTable(
  "settlement_runs",
  {
    id: text().primaryKey(),
    startedAt: tsNow(),
    finishedAt: ts(),
    durationMs: integer(),
    scannedBets: integer().notNull().default(0),
    uniqueEvents: integer().notNull().default(0),
    settledDeterministically: integer().notNull().default(0),
    applied: integer().notNull().default(0),
    stillPending: integer().notNull().default(0),
    tier0Hits: integer().notNull().default(0),
    tier1Hits: integer().notNull().default(0),
    tier2Hits: integer().notNull().default(0),
    tier3Hits: integer().notNull().default(0),
    tier4Hits: integer().notNull().default(0),
    unresolvedEvents: integer().notNull().default(0),
    /** "spend-cap" | "quota-exhausted" | null — surface when Tier 3 short-circuited. */
    abortedReason: text(),
    /** Free-form error message when the whole tick blew up. */
    error: text(),
    /** Cost estimate (USD) for this tick's paid-tier calls. */
    estimatedCostUsd: numeric({ precision: 8, scale: 5, mode: "number" }),
  },
  (t) => [index("settlement_runs_started_idx").on(t.startedAt.desc())],
);

export type SettlementRunRow = typeof settlementRuns.$inferSelect;
export type NewSettlementRunRow = typeof settlementRuns.$inferInsert;

/**
 * Cases where two settlement tiers disagreed on the score for the same
 * event — usually Tier 2 (football-data) vs Tier 3 (url_context). A
 * human can review the row, decide which source was right, and update
 * match_scores via `upsertScoreForce` to make the correct value permanent.
 *
 * Rare on paper: if football-data resolves a match, we won't call Tier 3
 * for it in the same tick. The discrepancy check runs on the NEXT tick
 * where Tier 0 already has the cached score and a fresh tier might
 * quietly try to resolve the same event and return something different.
 * That quiet disagreement is exactly what we want flagged.
 */
export const settlementDisputes = pgTable(
  "settlement_disputes",
  {
    id: text().primaryKey(),
    eventId: text().notNull(),
    cachedSource: text().notNull(),
    cachedFtHome: integer().notNull(),
    cachedFtAway: integer().notNull(),
    newSource: text().notNull(),
    newFtHome: integer().notNull(),
    newFtAway: integer().notNull(),
    cachedConfidence: numeric({
      precision: 3,
      scale: 2,
      mode: "number",
    }).notNull(),
    newConfidence: numeric({
      precision: 3,
      scale: 2,
      mode: "number",
    }).notNull(),
    resolved: boolean().notNull().default(false),
    resolution: text(), // 'kept-cached' | 'accepted-new' | 'manual-override'
    detectedAt: tsNow(),
    resolvedAt: ts(),
  },
  (t) => [
    index("settlement_disputes_event_idx").on(t.eventId),
    index("settlement_disputes_unresolved_idx")
      .on(t.detectedAt.desc())
      .where(sql`${t.resolved} = false`),
  ],
);

export type SettlementDisputeRow = typeof settlementDisputes.$inferSelect;
export type NewSettlementDisputeRow = typeof settlementDisputes.$inferInsert;

/**
 * Bets we have actually PLACED on a soft book via our platform. Distinct
 * from `value_bets`, which stores the detected opportunity. One value bet
 * can produce at most one placed bet — enforced by a partial unique index
 * on (event_id, family_id, atom_id) that excludes cancelled rows.
 *
 * The placer chooses the provider with the best current odds at placement
 * time; the dedup key deliberately does NOT include provider so we can't
 * double-bet a selection across books.
 */
export const placedBets = pgTable(
  "placed_bets",
  {
    id: text().primaryKey(),
    valueBetId: text(),
    /**
     * Which strategy (if any) auto-placed this bet. Nullable for
     * manual placements and for auto-placements triggered by the
     * detector with no active strategy. Enables per-strategy live ROI.
     */
    strategyId: text(),

    eventId: text().notNull(),
    familyId: text().notNull(),
    atomId: text().notNull(),
    atomLabel: text().notNull(),
    eventName: text().notNull(),
    competition: text(),
    eventStartTime: ts().notNull(),
    marketType: text().notNull(),

    provider: text().notNull(),
    stake: numeric({ precision: 10, scale: 2, mode: "number" }).notNull(),
    odds: nz4().notNull(),
    currency: text().notNull().default("BDT"),
    providerTicketId: text(),
    mode: text().notNull(), // 'auto' | 'manual'

    closingOdds: nz4(),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),

    placedAt: tsNow(),
    outcome: text().notNull().default("pending"),
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    settledAt: ts(),
    settledBySource: text(),

    requestPayload: jsonb(),
    responsePayload: jsonb(),
    error: text(),

    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    // Partial UNIQUE index: one live (non-cancelled) placement per
    // selection, across all providers. Paired with the in-process
    // inflight lock in placer.ts — the lock prevents the common race,
    // this index is the last-line guarantee for multi-process / HMR
    // scenarios.
    uniqueIndex("placed_bets_dedup_idx")
      .on(t.eventId, t.familyId, t.atomId)
      .where(sql`${t.outcome} <> 'cancelled'`),
    index("placed_bets_placed_at_idx").on(t.placedAt.desc()),
    index("placed_bets_outcome_idx")
      .on(t.outcome)
      .where(sql`${t.outcome} <> 'pending'`),
    index("placed_bets_provider_idx").on(t.provider),
    index("placed_bets_value_bet_idx")
      .on(t.valueBetId)
      .where(sql`${t.valueBetId} IS NOT NULL`),
  ],
);

export type PlacedBetRow = typeof placedBets.$inferSelect;
export type NewPlacedBetRow = typeof placedBets.$inferInsert;

/**
 * Global betting settings — singleton row (id=1). Drives auto-placement
 * sizing, strategy choice, and safety rails. Editable from the dashboard
 * via GET/PUT /api/betting-settings. Defaults seeded on first read if
 * no row exists yet.
 *
 * `strategy_id` values are 1:1 with the backtest STRATEGIES array in
 * [lib/backtest/analyze.ts](../backtest/analyze.ts) — "flat", "kelly",
 * "frac-kelly-0.5", "frac-kelly-0.25", "ev-prop". No new list to keep
 * in sync.
 *
 * Bankroll semantics:
 *   - `use_live_balance=true` → placer uses the provider's live account
 *     balance as Kelly bankroll. Self-adjusting; preferred default.
 *   - `use_live_balance=false` → `manual_bankroll_bdt` is used.
 *
 * `unit_size_bdt` is the "1 unit" base for `flat` and `ev-prop`
 * strategies, which return multiples of 1 unit rather than fractions of
 * bankroll.
 */
export const bettingSettings = pgTable("betting_settings", {
  id: integer().primaryKey().default(1),

  strategyId: text().notNull().default("frac-kelly-0.25"),
  useLiveBalance: boolean().notNull().default(true),
  manualBankrollBdt: numeric({
    precision: 12,
    scale: 2,
    mode: "number",
  })
    .notNull()
    .default(1000),
  unitSizeBdt: numeric({ precision: 10, scale: 2, mode: "number" })
    .notNull()
    .default(200),
  kellyCapPct: numeric({ precision: 5, scale: 2, mode: "number" })
    .notNull()
    .default(10),
  minStakeBdt: numeric({ precision: 10, scale: 2, mode: "number" })
    .notNull()
    .default(200),
  stakeBucketBdt: numeric({ precision: 10, scale: 2, mode: "number" })
    .notNull()
    .default(100),
  minEvPct: numeric({ precision: 5, scale: 2, mode: "number" })
    .notNull()
    .default(2),
  maxOddsAgeSec: integer().notNull().default(90),

  // Safety rails. All nullable = "no limit".
  dailyMaxLossBdt: numeric({ precision: 12, scale: 2, mode: "number" }),
  dailyMaxStakeBdt: numeric({ precision: 12, scale: 2, mode: "number" }),
  maxConcurrentExposureBdt: numeric({
    precision: 12,
    scale: 2,
    mode: "number",
  }),
  maxBetsPerDay: integer(),
  cooldownAfterLossSec: integer(),

  updatedAt: tsNow(),
});

export type BettingSettingsRow = typeof bettingSettings.$inferSelect;
export type NewBettingSettingsRow = typeof bettingSettings.$inferInsert;

export const schema = {
  valueBets,
  strategies,
  strategyExecutions,
  matchScores,
  settlementRuns,
  settlementDisputes,
  placedBets,
  bettingSettings,
};
