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

/**
 * Unified bets table — merges the former value_bets and placed_bets.
 *
 * Key design:
 * - One row per unique (event_id, family_id, atom_id) selection.
 * - Placement fields (placed_at, provider, stake, odds, etc.) are NULL
 *   until a bet is actually placed. This lets us query:
 *     • All detected opportunities: SELECT * FROM bets
 *     • Only placed bets:          SELECT * FROM bets WHERE placed_at IS NOT NULL
 *     • Unmatched opportunities:  SELECT * FROM bets WHERE placed_at IS NULL
 *     • Manual bets only:         SELECT * FROM bets WHERE mode = 'manual'
 *     • Auto bets only:           SELECT * FROM bets WHERE mode = 'auto'
 */
export const bets = pgTable(
  "bets",
  {
    // Identity
    id: text().primaryKey(), // Stable: `${eventId}|${familyId}|${atomId}`

    // Event & Selection
    eventId: text().notNull(),
    familyId: text().notNull(),
    atomId: text().notNull(),
    atomLabel: text().notNull(),

    homeTeam: text().notNull(),
    awayTeam: text().notNull(),
    competition: text(),
    eventStartTime: ts().notNull(),

    marketType: text().notNull(),
    timeScope: text().notNull(),
    familyLine: numeric({ precision: 5, scale: 2, mode: "number" }),

    // Sharp side (Pinnacle reference — source of truth for EV)
    sharpProvider: text().notNull(),
    sharpOdds: nz4().notNull(),
    sharpTrueProb: numeric({
      precision: 6,
      scale: 5,
      mode: "number",
    }).notNull(),
    sharpOddsAgeMs: integer(),

    // Soft side (the book we detected the opportunity on)
    softProvider: text().notNull(),
    softCommissionPct: numeric({
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    softOdds: nz4().notNull(), // Price at first detection

    // Closing lines (for CLV calculation)
    closingSharpOdds: nz4(),
    closingSoftOdds: nz4(),

    // Detection lifecycle
    firstSeenAt: ts().notNull(),
    lastSeenAt: ts().notNull(),
    tickCount: integer().notNull().default(1),

    // Placement record — all NULL until bet is actually placed
    placedAt: ts(),
    provider: text(),
    stake: numeric({ precision: 10, scale: 2, mode: "number" }),
    odds: nz4(),
    currency: text().default("BDT"),
    providerTicketId: text(),
    mode: text(), // 'auto' | 'manual'

    // API interaction metadata
    requestPayload: jsonb(),
    responsePayload: jsonb(),
    error: text(),

    // Outcome & settlement
    outcome: text().notNull().default("pending"),
    outcomeMarkedAt: ts(),
    settledBySource: text(),
    settledAt: ts(),
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),

    // Settlement pipeline tracking
    settleAttempts: integer().notNull().default(0),
    lastSettleAttemptAt: ts(),

    // AlphaSearch strategy attribution (Phase 3) — set at detection time
    // when a live strategy claims this bet. Lets us compute since-promotion
    // metrics per strategy and detect drift vs OOS estimate.
    strategyId: text(),

    // Timestamps
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index("bets_first_seen_idx").on(t.firstSeenAt.desc()),
    index("bets_market_idx").on(t.marketType, t.timeScope),
    index("bets_soft_provider_idx").on(t.softProvider),
    index("bets_event_start_idx").on(t.eventStartTime),
    index("bets_strategy_idx")
      .on(t.strategyId)
      .where(sql`${t.strategyId} IS NOT NULL`),
    // Settled non-pending rows (backtest queries)
    index("bets_outcome_idx")
      .on(t.outcome)
      .where(sql`${t.outcome} <> 'pending'`),
    // Only placed bets for dashboard queries
    index("bets_placed_idx")
      .on(t.placedAt.desc())
      .where(sql`${t.placedAt} IS NOT NULL`),
    // Dedup: one active (non-cancelled) placement per selection
    uniqueIndex("bets_dedup_idx")
      .on(t.eventId, t.familyId, t.atomId)
      .where(sql`${t.outcome} <> 'cancelled' AND ${t.placedAt} IS NOT NULL`),
    // Provider reconciliation
    index("bets_provider_idx")
      .on(t.provider)
      .where(sql`${t.provider} IS NOT NULL`),
    // Needs review: pending + attempted
    index("bets_settle_attempts_idx")
      .on(t.outcome, t.settleAttempts)
      .where(sql`${t.outcome} = 'pending' AND ${t.settleAttempts} > 0`),
  ],
);

export type BetRow = typeof bets.$inferSelect;
export type NewBetRow = typeof bets.$inferInsert;

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
 * Global betting settings — singleton row (id=1). Drives auto-placement
 * sizing and safety rails. Editable from the dashboard via GET/PUT
 * /api/betting-settings. Defaults seeded on first read if no row exists yet.
 *
 * Bankroll semantics:
 *   - `use_live_balance=true` → placer uses the provider's live account
 *     balance as Kelly bankroll. Self-adjusting; preferred default.
 *   - `use_live_balance=false` → `manual_bankroll_bdt` is used.
 *
 * `unit_size_bdt` is the "1 unit" base for flat sizing strategies,
 * which return multiples of 1 unit rather than fractions of bankroll.
 */
export const bettingSettings = pgTable("betting_settings", {
  id: integer().primaryKey().default(1),

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
  // Kelly multiplier: 1.0 = full Kelly, 0.5 = half, 0.25 = quarter (default),
  // 0.125 = eighth. Applied to full-Kelly fraction before the `kellyCapPct`
  // bankroll ceiling.
  kellyFraction: numeric({ precision: 5, scale: 3, mode: "number" })
    .notNull()
    .default(0.25),
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

/**
 * AlphaSearch — parameter-optimization run.
 *
 * Each row is one user-submitted (or scheduled) sweep over a search space.
 * The Next.js side creates the row with status='queued'; the Python sidecar
 * picks it up, sets status='running', writes child trials, and eventually
 * sets status='completed' with a populated `summary`.
 */
export const optimizationRuns = pgTable(
  "optimization_runs",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    status: text().notNull().default("queued"), // queued | running | completed | failed | cancelled
    searchSpace: jsonb().notNull(),
    searchAlgorithm: text().notNull(), // ensemble | tpe | nsga2 | random
    nTrialsTarget: integer().notNull(),
    nTrialsDone: integer().notNull().default(0),
    rngSeed: integer().notNull(),
    cvStrategy: jsonb().notNull(), // { type, n_groups, n_test_groups, embargo_pct }
    // Pre-search data scope filter — narrows which historical bets enter the
    // analysis at all (vs. `searchSpace` which tunes within the included set).
    // Default = empty object = include every settled bet. Shape:
    //   {
    //     excludeSoftProviders?: string[],   // e.g. ["ninewickets-exchange"]
    //     includeSoftProviders?: string[],   // takes precedence if both set
    //     excludeMarketTypes?: string[],     // e.g. ["BTTS"]
    //     includeMarketTypes?: string[],
    //     eventStartFrom?: string (ISO),     // e.g. "2026-01-01T00:00:00Z"
    //     eventStartTo?: string (ISO),
    //     placedOnly?: boolean,              // if true: WHERE placed_at IS NOT NULL
    //   }
    dataFilters: jsonb().notNull().default({}),
    baselineMetrics: jsonb(), // global config evaluated on same splits
    summary: jsonb(), // pareto frontier, DSR, PBO, top-K (populated at end)
    bestTrialId: text(),
    error: text(),
    startedAt: ts(),
    completedAt: ts(),
    createdBy: text(),
    createdAt: tsNow(),
  },
  (t) => [
    index("optimization_runs_status_idx").on(t.status),
    index("optimization_runs_created_idx").on(t.createdAt.desc()),
    // Queue lookup for the scheduler poll.
    index("optimization_runs_queued_idx")
      .on(t.createdAt)
      .where(sql`${t.status} = 'queued'`),
  ],
);

export type OptimizationRunRow = typeof optimizationRuns.$inferSelect;
export type NewOptimizationRunRow = typeof optimizationRuns.$inferInsert;

/**
 * AlphaSearch — single trial result inside a run.
 *
 * One row per (sampled config × full CV evaluation). The Python sidecar
 * writes these as the trial loop progresses; the Next.js UI reads them
 * for live progress + the final Pareto / trial table.
 */
export const optimizationTrials = pgTable(
  "optimization_trials",
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => optimizationRuns.id, { onDelete: "cascade" }),
    trialIndex: integer().notNull(),
    sampler: text().notNull(), // random | tpe | nsga2
    params: jsonb().notNull(),
    foldMetrics: jsonb().notNull(), // per-CPCV-path metrics

    // Aggregated OOS metrics (precomputed for fast sort/filter in UI).
    oosRoiMean: numeric({ precision: 8, scale: 4, mode: "number" }),
    oosRoiCiLow: numeric({ precision: 8, scale: 4, mode: "number" }),
    oosRoiCiHigh: numeric({ precision: 8, scale: 4, mode: "number" }),
    oosSortino: numeric({ precision: 8, scale: 4, mode: "number" }),
    oosSharpe: numeric({ precision: 8, scale: 4, mode: "number" }),
    deflatedSharpe: numeric({ precision: 8, scale: 4, mode: "number" }),
    probabilisticSharpe: numeric({ precision: 6, scale: 4, mode: "number" }),
    maxDrawdown: numeric({ precision: 8, scale: 4, mode: "number" }),
    sampleSize: integer(),
    compositeScore: numeric({ precision: 8, scale: 4, mode: "number" }),
    onPareto: boolean().notNull().default(false),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex("optimization_trials_run_index_idx").on(t.runId, t.trialIndex),
    index("optimization_trials_score_idx").on(t.runId, t.compositeScore.desc()),
    index("optimization_trials_pareto_idx")
      .on(t.runId)
      .where(sql`${t.onPareto} = true`),
  ],
);

export type OptimizationTrialRow = typeof optimizationTrials.$inferSelect;
export type NewOptimizationTrialRow = typeof optimizationTrials.$inferInsert;

/**
 * AlphaSearch — promoted live strategy.
 *
 * A strategy is a configuration that the value-detector consults on every
 * tick. When a detected value bet matches the strategy's `filters`, the
 * bet is tagged with `strategy_id` and the strategy's `sizing` overrides
 * the global Kelly settings.
 *
 * Lifecycle: candidate → live → paused → retired.
 *
 * `filters` JSON shape mirrors the search-space dimension naming so a
 * trial config can be promoted directly:
 *   {
 *     min_ev_pct?: number,
 *     max_odds_age_sec?: number,
 *     min_sharp_prob?: number,
 *     odds_lo?: number, odds_hi?: number,
 *     min_tick_count?: number,
 *     pre_match_only?: boolean,
 *     soft_providers?: string[],   // include-only
 *     market_types?: string[],     // include-only
 *   }
 *
 * `sizing` JSON: { kelly_fraction, kelly_cap_pct, staking_scheme }
 *
 * `metrics_snapshot` is the OOS metrics + CI captured at promotion time.
 * `live_metrics` is recomputed nightly from `bets WHERE strategy_id = X`.
 */
export const optimizationStrategies = pgTable(
  "optimization_strategies",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    source: text().notNull().default("optimizer"), // optimizer | manual
    sourceRunId: text(),
    sourceTrialId: text(),
    filters: jsonb().notNull(),
    sizing: jsonb().notNull(),
    status: text().notNull().default("candidate"), // candidate | live | paused | retired
    metricsSnapshot: jsonb().notNull(),
    liveMetrics: jsonb(),
    activatedAt: ts(),
    pausedAt: ts(),
    retiredAt: ts(),
    createdBy: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index("optimization_strategies_status_idx").on(t.status),
    // Hot path for value-detector: filter to live strategies only.
    index("optimization_strategies_live_idx")
      .on(t.id)
      .where(sql`${t.status} = 'live'`),
    index("optimization_strategies_created_idx").on(t.createdAt.desc()),
  ],
);

export type OptimizationStrategyRow =
  typeof optimizationStrategies.$inferSelect;
export type NewOptimizationStrategyRow =
  typeof optimizationStrategies.$inferInsert;

/**
 * AlphaSearch Phase 5 — periodic re-validation of a live strategy.
 *
 * Every ~7 days the auto-validator re-evaluates each live strategy's
 * filters against the latest bet data and writes one row here. Three
 * consecutive `drift_flag=true` rows for the same strategy → auto-pause.
 *
 * The history is the audit trail: a paused strategy's `strategy_validations`
 * rows show why it was paused and when each drift was first detected.
 */
export const strategyValidations = pgTable(
  "strategy_validations",
  {
    id: text().primaryKey(),
    strategyId: text()
      .notNull()
      .references(() => optimizationStrategies.id, { onDelete: "cascade" }),
    ranAt: tsNow(),
    nSettled: integer().notNull().default(0),
    liveRoiPct: numeric({ precision: 8, scale: 4, mode: "number" }),
    snapshotRoiMean: numeric({ precision: 8, scale: 4, mode: "number" }),
    snapshotRoiCiLow: numeric({ precision: 8, scale: 4, mode: "number" }),
    snapshotRoiCiHigh: numeric({ precision: 8, scale: 4, mode: "number" }),
    /** True if liveRoiPct sits outside [snapshotRoiCiLow, snapshotRoiCiHigh]. */
    driftFlag: boolean().notNull().default(false),
    /** Running counter — bumped each consecutive flagged check; reset to 0 on a clean check. */
    consecutiveDrifts: integer().notNull().default(0),
    /** Set when this validation triggered an auto-pause action. */
    triggeredAutoPause: boolean().notNull().default(false),
    /** Optional free-form note (used for "auto-paused after N consecutive drifts"). */
    note: text(),
  },
  (t) => [
    index("strategy_validations_strategy_idx").on(t.strategyId, t.ranAt.desc()),
    index("strategy_validations_ran_idx").on(t.ranAt.desc()),
  ],
);

export type StrategyValidationRow = typeof strategyValidations.$inferSelect;
export type NewStrategyValidationRow = typeof strategyValidations.$inferInsert;

/**
 * AlphaSearch — recurring optimization run.
 *
 * Defines a saved configuration that the optimizer scheduler will fire on
 * a schedule (e.g. "every day at 03:00 Asia/Dhaka"). Each fire creates a
 * fresh row in `optimization_runs` from this schedule's snapshot, so a
 * schedule's history = the runs that point back at its id via
 * optimization_runs.created_by = `schedule:<id>`.
 *
 * `frequency` is a discriminated tag matching the lib/optimizer/schedules.ts
 * Frequency union (preset list — not a free-form cron string for v1):
 *   { kind: "every_n_hours", hours: 1|2|4|6|12 }
 *   { kind: "daily",         hourLocal: 0..23 }
 *   { kind: "weekly",        dayOfWeek: 0..6, hourLocal: 0..23 }
 *
 * `nextFireAt` is the absolute UTC instant the next firing happens — the
 * scheduler tick polls `WHERE enabled AND next_fire_at <= now()` and
 * recomputes after each fire.
 */
export const optimizationSchedules = pgTable(
  "optimization_schedules",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    enabled: boolean().notNull().default(true),
    timezone: text().notNull().default("Asia/Dhaka"),
    frequency: jsonb().notNull(), // see comment above
    nTrialsTarget: integer().notNull().default(2000),
    searchAlgorithm: text().notNull().default("ensemble"), // ensemble|tpe|nsga2|random
    searchSpace: jsonb().notNull().default({}),
    cvStrategy: jsonb().notNull(),
    dataFilters: jsonb().notNull().default({}),
    notifyOnComplete: boolean().notNull().default(false),
    lastFireAt: ts(),
    lastRunId: text(),
    nextFireAt: ts().notNull(),
    createdBy: text(),
    createdAt: tsNow(),
    updatedAt: tsNow(),
  },
  (t) => [
    index("optimization_schedules_due_idx")
      .on(t.nextFireAt)
      .where(sql`${t.enabled} = true`),
    index("optimization_schedules_created_idx").on(t.createdAt.desc()),
  ],
);

export type OptimizationScheduleRow = typeof optimizationSchedules.$inferSelect;
export type NewOptimizationScheduleRow =
  typeof optimizationSchedules.$inferInsert;

export const schema = {
  bets,
  matchScores,
  settlementRuns,
  settlementDisputes,
  bettingSettings,
  optimizationRuns,
  optimizationTrials,
  optimizationSchedules,
  optimizationStrategies,
  strategyValidations,
};
