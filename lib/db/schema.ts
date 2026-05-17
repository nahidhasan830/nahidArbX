import { sql } from "drizzle-orm";
import type { MarketPhase } from "@/lib/betting/market-phase";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
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

    // Outcome & settlement
    outcome: text().notNull().default("pending"),
    settledBySource: text(),
    settledAt: ts(),
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),

    // Settlement pipeline tracking
    settleAttempts: integer().notNull().default(0),
    lastSettleAttemptAt: ts(),

    // Odds movement history — JSONB snapshot of per-provider line movement
    // at the time the value bet was detected/updated. New format is
    // Record<string, OddsMovementData> keyed by provider ID; legacy rows
    // may contain a single OddsMovementData object directly.
    oddsMovement: jsonb().$type<
      | Record<string, import("@/lib/bets-history/types").OddsMovementData>
      | import("@/lib/bets-history/types").OddsMovementData
      | null
    >(),

    // ML pipeline columns
    mlFeatures: real("ml_features").array(), // 25-dim feature vector (real[] for speed and preventing JSONB tuple bloat during HOT updates)
    mlScore: real(), // Calibrated P(win) from LightGBM [0,1]; staker converts to model EV at offered odds
    mlStakeFraction: real("ml_stake_fraction"), // Model-adjusted stake fraction = baseline × multiplier (capped). Renamed from ml_kelly_adjusted.
    mlFeatureVersion: integer(), // Feature contract version at extraction time
    mlFeatureCount: integer(), // Feature vector length at extraction time
    mlFeatureNamesHash: text(), // SHA-256 of feature names for drift detection
  },
  (t) => [
    index("bets_first_seen_idx").on(t.firstSeenAt.desc()),
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
 * Auto-placer decision log — captures every auto-placement attempt,
 * whether it succeeded, was skipped, rejected, or errored. Used for
 * diagnosing strategy middleware compliance, balance issues, and
 * provider problems.
 *
 * Rows are append-only and never updated. The same bet ID can appear
 * multiple times (one per tick that re-evaluates it).
 */
export const autoPlacerLog = pgTable(
  "auto_placer_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    /** Timestamp of the decision. */
    createdAt: tsNow(),
    /** Deterministic bet ID: `${eventId}|${familyId}|${atomId}`. */
    betId: text().notNull(),
    /** Which gate/stage produced this outcome. */
    gate: text().notNull(), // 'toggle' | 'adapter' | 'ml_score' | 'row_missing' | 'inflight' | 'refs' | 'account' | 'ev_floor' | 'balance' | 'market_max' | 'dedup' | 'book_reject' | 'book_error' | 'placed' | 'pending'
    /** Outcome status. */
    status: text().notNull(), // 'skipped' | 'rejected' | 'error' | 'placed' | 'pending'
    /** Human-readable reason (populated for non-success outcomes). */
    reason: text(),
    /** Soft provider attempted. */
    softProvider: text().notNull(),
    /** Event teams for display. */
    homeTeam: text(),
    awayTeam: text(),
    competition: text(),
    eventStartTime: ts(),
    /** Market context. */
    marketType: text(),
    atomLabel: text(),
    /** Pricing at decision time. */
    softOdds: nz4(),
    sharpOdds: nz4(),
    evPct: numeric({ precision: 6, scale: 2, mode: "number" }),
    /** ML context (null when no model loaded). */
    mlScore: real(),
    /** Stake attempted (null when skipped before sizing). */
    stake: numeric({ precision: 10, scale: 2, mode: "number" }),
    /** Balance at decision time (null when skipped before balance check). */
    balance: numeric({ precision: 10, scale: 2, mode: "number" }),
    /** Booked odds (only for placed/pending). */
    bookedOdds: nz4(),
    /** Provider ticket ID (only for placed/pending). */
    ticketId: text(),
  },
  (t) => [
    index("auto_placer_log_created_idx").on(t.createdAt.desc()),
    index("auto_placer_log_bet_idx").on(t.betId),
    index("auto_placer_log_status_idx").on(t.status),
    index("auto_placer_log_provider_idx").on(t.softProvider),
  ],
);

export type AutoPlacerLogRow = typeof autoPlacerLog.$inferSelect;
export type NewAutoPlacerLogRow = typeof autoPlacerLog.$inferInsert;

/**
 * Settled match scores — permanent cache keyed by normalized eventId.
 *
 * Populated by the settlement waterfall from the cheapest available source
 * that can resolve the final score (live feeds → free APIs → HF+Search).
 * Scores are effectively immutable once status='FT', so this doubles as a
 * long-term archive: every re-settlement hits this table first at tier 0
 * and costs $0.
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
    /**
     * Booking points per team (FT). Pinnacle convention:
     * 1 pt per yellow + 2 pts per red. NULL on events resolved
     * before we added bookings support.
     */
    bookingsHome: integer(),
    bookingsAway: integer(),
    source: text().notNull(), // 'pinnacle-ws' | 'betconstruct' | 'espn' | 'api-football' | 'sofascore' | 'ai-search-deepseek' | 'manual'
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
 * event. A human can review the row, decide which source was right, and
 * update match_scores via `upsertScoreForce` to make the correct value
 * permanent.
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
 * sizing. Editable from the dashboard via GET/PUT
 * /api/settings. Defaults seeded on first read if no row exists yet.
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
  valueDetectionPhases: jsonb("value_detection_phases")
    .$type<MarketPhase[]>()
    .notNull()
    .default(sql`'["pre_match"]'::jsonb`),
  betPlacementPhases: jsonb("bet_placement_phases")
    .$type<MarketPhase[]>()
    .notNull()
    .default(sql`'["pre_match"]'::jsonb`),

  mlMinScore: numeric({ precision: 4, scale: 2, mode: "number" })
    .notNull()
    .default(0.4),

  updatedAt: tsNow(),
});

export type BettingSettingsRow = typeof bettingSettings.$inferSelect;
export type NewBettingSettingsRow = typeof bettingSettings.$inferInsert;

/**
 * ML Models — lifecycle tracking for LightGBM models.
 *
 * Each row represents a trained model version. The training pipeline
 * (Python sidecar on Cloud Run Job) writes rows here after CPCV
 * evaluation. Only models passing quality gates (DSR > 0.8, PBO < 0.5)
 * get status='deployed'. The Node.js ONNX scorer watches for the latest
 * deployed model and hot-reloads it.
 */
export const mlModels = pgTable(
  "ml_models",
  {
    id: text().primaryKey(),
    version: integer().notNull(),
    status: text().notNull().default("training"), // training|validated|deployed|retired|rejected
    modelType: text().notNull().default("lightgbm"),
    trainingSamples: integer().notNull(),
    featureCount: integer().notNull().default(25),
    featureVersion: integer().notNull().default(2),
    featureNamesHash: text(),
    trainingStartedAt: ts().notNull(),
    trainingCompletedAt: ts(),
    oosRoiMean: numeric({ precision: 14, scale: 4, mode: "number" }),
    oosAccuracy: numeric({ precision: 6, scale: 4, mode: "number" }),
    oosAucRoc: numeric({ precision: 6, scale: 4, mode: "number" }),
    oosLogLoss: numeric({ precision: 8, scale: 6, mode: "number" }),
    deflatedSharpe: numeric({ precision: 14, scale: 4, mode: "number" }),
    pbo: numeric({ precision: 6, scale: 4, mode: "number" }),
    calibrationError: numeric({ precision: 8, scale: 6, mode: "number" }),
    featureImportance: jsonb(),
    modelArtifactPath: text(),
    /** Raw ONNX model binary stored in Postgres (bytea). Typically <1MB for LightGBM.
     *  The scorer reads this blob directly — no GCS or local file cache needed. */
    onnxBlob: customType<{ data: Buffer; driverData: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("onnx_blob"),
    trainingReport: jsonb(),
    /** Runtime permission level assigned by the deployment gate. */
    permissionLevel: text().default("observe"), // observe|gate_only|stake_reduce|stake_increase
    /** JSON array of reasons why a model was rejected by the deployment gate (null if accepted). */
    rejectionReasons: jsonb().$type<string[] | null>(),
    deployedAt: ts(),
    retiredAt: ts(),
    /** Telegram notification timestamp — restart-safe idempotency marker. */
    notifiedAt: ts(),
    createdAt: tsNow(),
  },
  (t) => [
    index("ml_models_status_idx").on(t.status),
    index("ml_models_deployed_idx")
      .on(t.deployedAt.desc())
      .where(sql`${t.status} = 'deployed'`),
  ],
);

export type MlModelRow = typeof mlModels.$inferSelect;
export type NewMlModelRow = typeof mlModels.$inferInsert;

/**
 * Entity Resolution — replaces the JSON alias store.
 *
 * Three tables jointly model identity, evidence, and audit:
 *
 *   - entities          — stable real-world things (teams, competitions)
 *   - entity_names      — surface forms bound to entities, scoped by
 *                         (provider, surface_normalized, competition_id)
 *   - name_observations — append-only ledger of every match attempt
 *
 * The lookup hot path resolves on (provider, surface_normalized,
 * competition_id), so "Athletic" in La Liga and "Athletic" in Colombian
 * Primera A coexist as distinct rows pointing to distinct entities — the
 * core fix for the old global-namespace tournament-blind store.
 */
export const entities = pgTable(
  "entities",
  {
    id: text().primaryKey(),
    kind: text().notNull(), // 'team' | 'competition'
    canonicalName: text().notNull(),
    country: text(),
    gender: text(), // 'm' | 'f' | null (competitions are null)
    parentId: text(),
    metadata: jsonb().notNull().default({}),
    createdAt: tsNow(),
    retiredAt: ts(),
  },
  (t) => [
    index("entities_kind_idx")
      .on(t.kind)
      .where(sql`${t.retiredAt} IS NULL`),
    index("entities_canonical_idx")
      .on(sql`lower(${t.canonicalName})`)
      .where(sql`${t.retiredAt} IS NULL`),
    index("entities_parent_idx")
      .on(t.parentId)
      .where(sql`${t.parentId} IS NOT NULL`),
  ],
);

export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;

export const entityNames = pgTable(
  "entity_names",
  {
    id: text().primaryKey(),
    entityId: text().notNull(),
    competitionId: text(), // NULL = global (rare)
    provider: text().notNull(),
    surfaceRaw: text().notNull(),
    surfaceNormalized: text().notNull(),
    // surface_embedding is vector(1024) in PG (BGE-M3 dim) but Drizzle has
    // no native vector type — we read/write it via raw SQL from the
    // entity-matcher service and skip it in normal selects. Omitted from
    // the typed schema on purpose.
    weight: real().notNull().default(1.0),
    positiveObs: integer("positive_obs").notNull().default(0),
    negativeObs: integer("negative_obs").notNull().default(0),
    status: text().notNull(), // 'candidate' | 'active' | 'retired'
    classifierScore: real("classifier_score"),
    conformalPvalue: real("conformal_pvalue"),
    firstSeenAt: tsNow(),
    lastSeenAt: tsNow(),
    promotedAt: ts(),
    retiredAt: ts(),
  },
  (t) => [
    uniqueIndex("entity_names_unique_surface").on(
      t.provider,
      t.surfaceNormalized,
      t.competitionId,
    ),
    index("entity_names_active_lookup_idx")
      .on(t.provider, t.surfaceNormalized, t.competitionId)
      .where(sql`${t.status} = 'active'`),
    index("entity_names_global_lookup_idx")
      .on(t.surfaceNormalized)
      .where(sql`${t.status} = 'active'`),
    index("entity_names_entity_idx").on(t.entityId),
    index("entity_names_candidate_idx")
      .on(t.lastSeenAt.desc())
      .where(sql`${t.status} = 'candidate'`),
    index("entity_names_decay_idx")
      .on(t.lastSeenAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export type EntityNameRow = typeof entityNames.$inferSelect;
export type NewEntityNameRow = typeof entityNames.$inferInsert;

export const nameObservations = pgTable(
  "name_observations",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    observedAt: tsNow(),
    surfaceRaw: text().notNull(),
    surfaceNormalized: text().notNull(),
    competitionId: text(),
    provider: text().notNull(),
    pairedWithEntityId: text(),
    matchScore: real("match_score"),
    classifierScore: real("classifier_score"),
    outcome: text().notNull(), // matched | rejected | near-match | manual-confirm | manual-reject
    source: text().notNull(), // harvester | match-review | learner | settle
    metadata: jsonb().notNull().default({}),
  },
  (t) => [
    index("name_obs_lookup_idx").on(
      t.surfaceNormalized,
      t.competitionId,
      t.observedAt.desc(),
    ),
    index("name_obs_recent_idx").on(t.observedAt.desc()),
    index("name_obs_entity_idx")
      .on(t.pairedWithEntityId, t.observedAt.desc())
      .where(sql`${t.pairedWithEntityId} IS NOT NULL`),
  ],
);

export type NameObservationRow = typeof nameObservations.$inferSelect;
export type NewNameObservationRow = typeof nameObservations.$inferInsert;

/**
 * Override blocklist (Layer 1 of the error-mitigation strategy:
 * reversibility). When the operator overrides an auto-decision, a row
 * lands here with a 30-day expiry. The auto-resolver checks this before
 * any potential auto-confirm — so the same wrong decision can't be
 * re-applied by the next sync. After 30 days the entry expires (the
 * model has had time to retrain on the negative signal by then).
 */
export const entityDecisionBlocklist = pgTable(
  "entity_decision_blocklist",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    provider: text().notNull(),
    surfaceNormalized: text().notNull(),
    competitionId: text(),
    blockedEntityId: text().notNull(),
    reason: text().notNull(), // 'manual-reject' | 'manual-confirm-undone' | 'tainted-cascade'
    createdAt: tsNow(),
    expiresAt: ts().notNull(),
  },
  (t) => [
    // Can't use a partial index on `expires_at > now()` (now() isn't
    // IMMUTABLE). Full index is fine — this table grows only on operator
    // overrides and the daily expiry sweep keeps it bounded.
    index("entity_blocklist_lookup_idx").on(
      t.provider,
      t.surfaceNormalized,
      t.competitionId,
      t.blockedEntityId,
    ),
    index("entity_blocklist_expiry_idx").on(t.expiresAt),
  ],
);

export type EntityDecisionBlocklistRow =
  typeof entityDecisionBlocklist.$inferSelect;
export type NewEntityDecisionBlocklistRow =
  typeof entityDecisionBlocklist.$inferInsert;

/**
 * ML-Augmented Matcher Pipeline — event pairs flowing through a 4-stage
 * state machine: inbox → ml_queued → human_review → history.
 *
 * Replaces the file-backed near-matches.json + ai-decision-cache.json.
 */
export const matchPairs = pgTable(
  "match_pairs",
  {
    id: text().primaryKey(),
    stage: text().notNull(), // 'inbox' | 'ml_queued' | 'human_review' | 'history'

    // Event A snapshot
    eventAProvider: text().notNull(),
    eventAHomeTeam: text().notNull(),
    eventAAwayTeam: text().notNull(),
    eventACompetition: text().notNull(),
    eventAStartTime: ts().notNull(),
    eventAEventId: text(),

    // Event B snapshot
    eventBProvider: text().notNull(),
    eventBHomeTeam: text().notNull(),
    eventBAwayTeam: text().notNull(),
    eventBCompetition: text().notNull(),
    eventBStartTime: ts().notNull(),
    eventBEventId: text(),

    // String similarity (from sync)
    stringScore: real().notNull(),
    stringBreakdown: jsonb(),

    // ML scores (bi-encoder)
    mlHomeCosine: real(),
    mlAwayCosine: real(),
    mlCompCosine: real(),
    mlCombinedScore: real(),
    mlScoredAt: ts(),
    mlModelVersion: text(),

    // Cross-encoder (bi-encoder uncertain band)
    xeScore: real(),
    xePvalue: real(),
    xeScoredAt: ts(),

    // Resolution
    decision: text(),
    decidedBy: text(),
    decidedAt: ts(),
    decisionReason: text(),

    // Canonical pair key (dedup + lookup)
    pairKey: text().notNull().unique(),

    // Timestamps
    detectedAt: tsNow(),
    stageChangedAt: tsNow(),

    // Source tracking
    source: text().notNull(), // 'near-match' | 'unmatched-candidate'
  },
  (t) => [
    index("match_pairs_stage_idx").on(t.stage),
    index("match_pairs_stage_detected_idx").on(t.stage, t.detectedAt.desc()),
  ],
);

export type MatchPairRow = typeof matchPairs.$inferSelect;
export type NewMatchPairRow = typeof matchPairs.$inferInsert;

/**
 * matcher_config — singleton config row read by the ML server scheduler.
 * The UI writes config here; the ML server reads it every tick.
 */
export const matcherConfig = pgTable("matcher_config", {
  id: text().primaryKey().default("default"),
  enabled: boolean().notNull().default(false),
  intervalMs: integer("interval_ms").notNull().default(60000),

  teamMergeThreshold: real("team_merge_threshold").notNull().default(0.9),
  compMergeThreshold: real("comp_merge_threshold").notNull().default(0.75),
  teamRejectThreshold: real("team_reject_threshold").notNull().default(0.5),
  combinedMergeThreshold: real("combined_merge_threshold")
    .notNull()
    .default(0.88),
  combinedRejectThreshold: real("combined_reject_threshold")
    .notNull()
    .default(0.5),

  xeEscalationEnabled: boolean("xe_escalation_enabled").notNull().default(true),
  xeEscalationLow: real("xe_escalation_low").notNull().default(0.7),
  xeEscalationHigh: real("xe_escalation_high").notNull().default(0.89),
  xeMergeThreshold: real("xe_merge_threshold").notNull().default(0.9),
  xePvalueThreshold: real("xe_pvalue_threshold").notNull().default(0.05),

  aiSearchEnabled: boolean("ai_search_enabled").notNull().default(true),
  aiSearchConfidenceThreshold: integer("ai_search_confidence_threshold")
    .notNull()
    .default(70),
  aiSearchMaxBatchSize: integer("ai_search_max_batch_size")
    .notNull()
    .default(20),

  updatedAt: ts().notNull().defaultNow(),
});

export type MatcherConfigRow = typeof matcherConfig.$inferSelect;

/**
 * matcher_runs — persisted run history written by the ML server scheduler.
 * The UI reads this to show the processing log.
 */
export const matcherRuns = pgTable(
  "matcher_runs",
  {
    id: text().primaryKey(),
    startedAt: ts().notNull().defaultNow(),
    completedAt: ts(),
    durationMs: integer("duration_ms"),
    processed: integer().notNull().default(0),
    merged: integer().notNull().default(0),
    rejected: integer().notNull().default(0),
    escalated: integer().notNull().default(0),
    aiSearchAttempted: integer("ai_search_attempted").notNull().default(0),
    aiSearchMerged: integer("ai_search_merged").notNull().default(0),
    aiSearchRejected: integer("ai_search_rejected").notNull().default(0),
    status: text().notNull().default("running"),
    trigger: text().notNull().default("scheduler"),
    errorMessage: text("error_message"),
  },
  (t) => [index("matcher_runs_started_idx").on(t.startedAt.desc())],
);

export type MatcherRunRow = typeof matcherRuns.$inferSelect;

/**
 * Persistent Telegram command history
 */
export const telegramCommandHistory = pgTable(
  "telegram_command_history",
  {
    id: bigserial({ mode: "bigint" }).primaryKey(),
    at: tsNow(),
    command: text().notNull(),
    text: text().notNull(),
    fromUserId: integer(),
    outcome: text().notNull(), // 'ok' | 'denied' | 'unknown' | 'error'
    durationMs: integer().notNull(),
    error: text(),
  },
  (t) => [
    index("telegram_history_at_idx").on(t.at.desc()),
    index("telegram_history_command_idx").on(t.command),
  ],
);

export type TelegramCommandHistoryRow =
  typeof telegramCommandHistory.$inferSelect;
export type NewTelegramCommandHistoryRow =
  typeof telegramCommandHistory.$inferInsert;

/**
 * AI Search logs — append-only audit trail for every call through the
 * ai-search Python service proxy. Written by the Next.js API route so
 * the Python service stays stateless.
 *
 * `endpoint` is the technical path ("search", "entity-match", etc.).
 * `service` is a human-friendly caller label ("Playground", "Auto Matcher",
 * "Auto Settler") so the Logs DataTable is instantly scannable.
 */
export const aiSearchLogs = pgTable(
  "ai_search_logs",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    createdAt: tsNow(),
    /** Technical endpoint: 'search' | 'entity-match' | 'grounded-query' | 'verify-settlement' */
    endpoint: text().notNull(),
    /** Human-readable caller: 'Playground' | 'Auto Matcher' | 'Auto Settler' | 'Manual' */
    service: text().notNull().default("Manual"),
    status: text().notNull(), // 'success' | 'error'
    providerUsed: text(),
    modelUsed: text(),
    query: text(), // search query or summary of input
    durationMs: integer(),
    resultCount: integer(),
    error: text(),
    requestBody: jsonb(), // truncated request payload
    responseSummary: jsonb(), // truncated response (decision, confidence, etc.)
  },
  (t) => [
    index("ai_search_logs_created_idx").on(t.createdAt.desc()),
    index("ai_search_logs_status_idx").on(t.status),
    index("ai_search_logs_service_idx").on(t.service),
  ],
);

export type AiSearchLogRow = typeof aiSearchLogs.$inferSelect;
export type NewAiSearchLogRow = typeof aiSearchLogs.$inferInsert;

/**
 * Unified AI activity log — append-only audit trail for every AI
 * operation across all subsystems: settlement (Gemini Tier 3),
 * grounding lab (HuggingFace/Groq), entity matching, and analysis.
 *
 * Gives the operator a single "AI Activity" page to inspect spend,
 * latency, outcomes, and error patterns without jumping between
 * disparate log views.
 */
export const aiActivityLog = pgTable(
  "ai_activity_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    createdAt: tsNow(),
    /** AI system: 'settlement' | 'grounding' | 'entity-match' | 'analysis' | 'propose' */
    system: text().notNull(),
    /** Triggering action: 'manual' | 'auto-scheduler' | 'playground' | 'batch' */
    trigger: text().notNull().default("manual"),
    /** 'success' | 'error' | 'partial' */
    status: text().notNull(),
    /** AI model used: 'gemini-lite' | 'gemini-flash' | 'gemini-pro' | etc */
    model: text(),
    /** Number of items processed (bets settled, queries run, pairs matched) */
    itemCount: integer(),
    /** Duration of the AI operation in ms */
    durationMs: integer(),
    /** Estimated cost in USD (null for free/local models) */
    costUsd: numeric({ precision: 8, scale: 5, mode: "number" }),
    /** Human-readable summary of what happened */
    summary: text(),
    /** Detailed error message (only on failure) */
    error: text(),
    /** Optional structured metadata (tier hits, scores, etc.) */
    metadata: jsonb(),
  },
  (t) => [
    index("ai_activity_log_created_idx").on(t.createdAt.desc()),
    index("ai_activity_log_system_idx").on(t.system),
    index("ai_activity_log_status_idx").on(t.status),
  ],
);

export type AiActivityLogRow = typeof aiActivityLog.$inferSelect;
export type NewAiActivityLogRow = typeof aiActivityLog.$inferInsert;

/**
 * Competition tiers — legacy table superseded by competition_enrichments.
 * Kept for backwards compatibility with the enrichment cache loader.
 */
export const competitionTiers = pgTable("competition_tiers", {
  name: text().primaryKey(),
  tier: integer().notNull(),
  classifiedAt: ts().notNull().defaultNow(),
});

export type CompetitionTierRow = typeof competitionTiers.$inferSelect;

/**
 * Competition enrichments — AI-classified competition metadata for
 * market-efficiency context in ML features.
 *
 * Replaces the simple tier cache with richer data: region, country,
 * competition level, market efficiency score, and AI confidence.
 * Populated by the background enrichment warmer in the engine.
 */
export const competitionEnrichments = pgTable(
  "competition_enrichments",
  {
    name: text().primaryKey(),
    displayName: text().notNull(),
    tier: integer().notNull().default(1),
    marketEfficiencyScore: integer().notNull().default(0),
    region: text(),
    country: text(),
    competitionLevel: text().notNull().default("unknown"),
    confidence: integer().notNull().default(0),
    model: text(),
    provider: text(),
    promptVersion: text().notNull(),
    sources: jsonb().notNull().default([]),
    rawResponse: jsonb(),
    classifiedAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("competition_enrichments_confidence_idx").on(t.confidence),
    index("competition_enrichments_classified_idx").on(t.classifiedAt.desc()),
  ],
);

export type CompetitionEnrichmentRow =
  typeof competitionEnrichments.$inferSelect;
export type NewCompetitionEnrichmentRow =
  typeof competitionEnrichments.$inferInsert;

/**
 * ML Training Examples — decouples ML training data from operational bets.
 *
 * Stores feature snapshots alongside outcomes, labels, and sample weights
 * for the LightGBM training pipeline. Supports multiple example types:
 *   - settled_detected: detected value bet that eventually settled
 *   - placed_settled: actually placed bet with real outcome
 *   - shadow_scored: feature snapshot at detection (outcome attached later)
 */
export const mlTrainingExamples = pgTable(
  "ml_training_examples",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sourceBetId: text(),
    exampleType: text().notNull(), // 'settled_detected' | 'placed_settled' | 'shadow_scored'
    eventId: text().notNull(),
    familyId: text().notNull(),
    atomId: text().notNull(),
    features: real().array(),
    featureVersion: integer().notNull().default(2),
    label: text(), // 'positive' | 'negative' | null (pending)
    labelSource: text(), // 'outcome' | 'clv' | null
    sampleWeight: real().notNull().default(1.0),
    outcome: text(), // 'won' | 'lost' | 'half_won' | 'half_lost' | 'void' | null
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),
    createdAt: tsNow(),
    settledAt: ts(),
  },
  (t) => [
    index("ml_training_examples_type_idx").on(t.exampleType),
    index("ml_training_examples_bet_idx").on(t.sourceBetId),
    index("ml_training_examples_version_idx").on(t.featureVersion),
    index("ml_training_examples_settled_idx")
      .on(t.settledAt.desc())
      .where(sql`${t.settledAt} IS NOT NULL`),
  ],
);

export type MlTrainingExampleRow = typeof mlTrainingExamples.$inferSelect;
export type NewMlTrainingExampleRow = typeof mlTrainingExamples.$inferInsert;

/**
 * Unified AI Provider Config — single source of truth for all AI providers.
 * Contains both enabling/disabled state AND usage quota tracking.
 *
 * Usage quota fields:
 * - totalUsageCount: cumulative requests from system start
 * - monthlyUsageCount: resets on 1st of each month (auto via scheduler)
 * - monthlyLimit: allowed requests per month (null = unlimited)
 *
 * Providers with limits: brave=1000, tavily=1000, vertex=1000
 * When quota exhausted and engineType='search', auto-disables provider.
 */
export const aiProviderConfig = pgTable("ai_provider_config", {
  // Identity
  name: text().primaryKey(),

  // Enabled/disabled state
  enabled: boolean().notNull().default(true),
  disabledReason: text("disabled_reason"),

  // Model metadata
  modelId: text("model_id"),
  tier: text(), // "lite" | "flash" | "pro"
  label: text(),
  tagline: text(),
  engineType: text("engine_type"), // "llm" | "search"

  // Quota tracking
  totalUsageCount: bigint({ mode: "number" }).notNull().default(0),
  monthlyUsageCount: integer("monthly_usage_count").notNull().default(0),
  monthlyLimit: integer("monthly_limit"), // null = unlimited
  lastResetAt: ts().notNull().defaultNow(),

  // Timestamps
  createdAt: tsNow(),
  updatedAt: ts().notNull().defaultNow(),
});

export type AiProviderConfigRow = typeof aiProviderConfig.$inferSelect;
export type NewAiProviderConfigRow = typeof aiProviderConfig.$inferInsert;

export const aiLogs = pgTable("ai_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  system: text().notNull(),
  trigger: text().notNull(),
  endpoint: text(),
  service: text(),
  status: text().notNull(),
  model: text(),
  providerUsed: text("provider_used"),
  itemCount: integer("item_count"),
  durationMs: integer("duration_ms"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
  query: text(),
  summary: text(),
  error: text(),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  metadata: jsonb(),
  createdAt: ts().notNull().defaultNow(),
});

export type AiLogRow = typeof aiLogs.$inferSelect;
export type NewAiLogRow = typeof aiLogs.$inferInsert;

export const schema = {
  bets,
  matchScores,
  settlementRuns,
  settlementDisputes,
  bettingSettings,
  entities,
  entityNames,
  nameObservations,
  entityDecisionBlocklist,
  matchPairs,
  matcherConfig,
  matcherRuns,
  telegramCommandHistory,
  mlModels,
  aiSearchLogs,
  aiActivityLog,
  competitionTiers,
  competitionEnrichments,
  mlTrainingExamples,
  aiProviderConfig,
  aiLogs,
};
