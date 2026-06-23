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

export const bets = pgTable(
  "bets",
  {
    id: text().primaryKey(), // Stable: `${eventId}|${familyId}|${atomId}`

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

    sharpProvider: text().notNull(),
    sharpOdds: nz4().notNull(),
    sharpTrueProb: numeric({
      precision: 6,
      scale: 5,
      mode: "number",
    }).notNull(),

    softProvider: text().notNull(),
    softCommissionPct: numeric({
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    softOdds: nz4().notNull(), // Price at first detection

    closingSharpOdds: nz4(),

    firstSeenAt: ts().notNull(),
    lastSeenAt: ts().notNull(),
    tickCount: integer().notNull().default(1),

    placedAt: ts(),
    provider: text(),
    stake: numeric({ precision: 10, scale: 2, mode: "number" }),
    odds: nz4(),
    currency: text().default("BDT"),
    providerTicketId: text(),
    mode: text(), // 'auto' | 'manual'

    outcome: text().notNull().default("pending"),
    settledBySource: text(),
    settledAt: ts(),
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),

    settleAttempts: integer().notNull().default(0),
    lastSettleAttemptAt: ts(),

    oddsMovement: jsonb().$type<
      | Record<string, import("@/lib/bets-history/types").OddsMovementData>
      | import("@/lib/bets-history/types").OddsMovementData
      | null
    >(),

    mlFeatures: real("ml_features").array(), // ML feature vector (real[] for speed and preventing JSONB tuple bloat during HOT updates)
    mlScore: real(), // Calibrated P(win) from LightGBM [0,1]; staker converts to model EV at offered odds
    mlStakeFraction: real("ml_stake_fraction"), // Model-adjusted stake fraction = baseline × multiplier (capped). Renamed from ml_kelly_adjusted.
    mlFeatureVersion: integer(), // Feature contract version at extraction time
    mlFeatureCount: integer(), // Feature vector length at extraction time
    mlFeatureNamesHash: text(), // SHA-256 of feature names for drift detection

    placedMlScore: real("placed_ml_score"),
    placedMlModelEdgePct: numeric("placed_ml_model_edge_pct", {
      precision: 8,
      scale: 3,
      mode: "number",
    }),
    placedMlDecision: text("placed_ml_decision"), // 'skip' | 'shrink' | 'agree' | 'boost'
    placedMlKellyMultiplier: real("placed_ml_kelly_multiplier"),
    placedMlModelVersion: integer("placed_ml_model_version"),
    placedMlFeatures: real("placed_ml_features").array(),
    placedMlFeatureVersion: integer("placed_ml_feature_version"),
    placedMlFeatureCount: integer("placed_ml_feature_count"),
    placedMlFeatureNamesHash: text("placed_ml_feature_names_hash"),
  },
  (t) => [
    index("bets_first_seen_idx").on(t.firstSeenAt.desc()),
    index("bets_outcome_idx")
      .on(t.outcome)
      .where(sql`${t.outcome} <> 'pending'`),
    index("bets_placed_idx")
      .on(t.placedAt.desc())
      .where(sql`${t.placedAt} IS NOT NULL`),
    uniqueIndex("bets_dedup_idx")
      .on(t.eventId, t.familyId, t.atomId)
      .where(sql`${t.outcome} <> 'cancelled' AND ${t.placedAt} IS NOT NULL`),
    index("bets_provider_idx")
      .on(t.provider)
      .where(sql`${t.provider} IS NOT NULL`),
    index("bets_settle_attempts_idx")
      .on(t.outcome, t.settleAttempts)
      .where(sql`${t.outcome} = 'pending' AND ${t.settleAttempts} > 0`),
  ],
);

export type BetRow = typeof bets.$inferSelect;
export type NewBetRow = typeof bets.$inferInsert;

export const autoPlacerLog = pgTable(
  "auto_placer_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    createdAt: tsNow(),
    betId: text().notNull(),
    gate: text().notNull(), // 'toggle' | 'adapter' | 'ml_score' | 'row_missing' | 'inflight' | 'refs' | 'account' | 'ev_floor' | 'balance' | 'market_max' | 'dedup' | 'book_reject' | 'book_error' | 'placed' | 'pending'
    status: text().notNull(), // 'skipped' | 'rejected' | 'error' | 'placed' | 'pending'
    reason: text(),
    softProvider: text().notNull(),
    homeTeam: text(),
    awayTeam: text(),
    competition: text(),
    eventStartTime: ts(),
    marketType: text(),
    atomLabel: text(),
    softOdds: nz4(),
    sharpOdds: nz4(),
    evPct: numeric({ precision: 6, scale: 2, mode: "number" }),
    mlScore: real(),
    mlModelEdgePct: numeric("ml_model_edge_pct", {
      precision: 8,
      scale: 3,
      mode: "number",
    }),
    mlDecision: text("ml_decision"),
    mlKellyMultiplier: real("ml_kelly_multiplier"),
    stake: numeric({ precision: 10, scale: 2, mode: "number" }),
    balance: numeric({ precision: 10, scale: 2, mode: "number" }),
    bookedOdds: nz4(),
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

export const mlPredictionAudit = pgTable(
  "ml_prediction_audit",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    predictionKey: text().notNull().unique(),
    createdAt: tsNow(),
    scoredAt: ts().notNull(),

    betId: text().notNull(),
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

    softProvider: text().notNull(),
    softOdds: nz4().notNull(),
    softCommissionPct: numeric({
      precision: 5,
      scale: 2,
      mode: "number",
    }).notNull(),
    sharpProvider: text().notNull(),
    sharpOdds: nz4().notNull(),
    sharpTrueProb: numeric({
      precision: 6,
      scale: 5,
      mode: "number",
    }).notNull(),
    baselineEvPct: numeric({ precision: 8, scale: 3, mode: "number" }),
    baselineKellyFraction: real(),

    modelVersion: integer(),
    mlScore: real().notNull(),
    modelEdgePct: numeric({ precision: 8, scale: 3, mode: "number" }),
    kellyMultiplier: real(),
    mlStakeFraction: real(),
    decision: text().notNull(), // 'boost' | 'shrink' | 'skip' | 'agree'
    permissionLevel: text().notNull(),

    mlFeatures: real("ml_features").array(),
    mlFeatureVersion: integer().notNull(),
    mlFeatureCount: integer().notNull(),
    mlFeatureNamesHash: text().notNull(),

    outcome: text().notNull().default("pending"),
    pnl: numeric({ precision: 10, scale: 2, mode: "number" }),
    clvPct: numeric({ precision: 6, scale: 2, mode: "number" }),
    settledAt: ts(),
  },
  (t) => [
    index("ml_prediction_audit_scored_idx").on(t.scoredAt.desc()),
    uniqueIndex("ml_prediction_audit_bet_unique").on(t.betId),
    index("ml_prediction_audit_model_idx").on(
      t.modelVersion,
      t.scoredAt.desc(),
    ),
    index("ml_prediction_audit_decision_idx").on(t.decision, t.scoredAt.desc()),
    index("ml_prediction_audit_market_idx").on(t.marketType, t.scoredAt.desc()),
    index("ml_prediction_audit_event_start_idx").on(t.eventStartTime.desc()),
    index("ml_prediction_audit_outcome_idx").on(t.outcome, t.scoredAt.desc()),
  ],
);

export type MlPredictionAuditRow = typeof mlPredictionAudit.$inferSelect;
export type NewMlPredictionAuditRow = typeof mlPredictionAudit.$inferInsert;

export const mlLearningSnapshots = pgTable(
  "ml_learning_snapshots",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    snapshotHash: text("snapshot_hash").notNull().unique(),
    modelVersion: integer("model_version"),
    verdict: text().notNull(),
    verdictReason: text("verdict_reason").notNull(),
    trigger: text().notNull().default("manual"), // manual|settlement|training|scheduler
    dataAsOf: timestamp("data_as_of", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    settledPredictionCount: integer("settled_prediction_count").notNull(),
    pendingPredictionCount: integer("pending_prediction_count").notNull(),
    scoredPredictionCount: integer("scored_prediction_count").notNull(),
    baselineRoiPct: numeric("baseline_roi_pct", {
      precision: 14,
      scale: 4,
      mode: "number",
    }),
    simpleRoiPct: numeric("simple_roi_pct", {
      precision: 14,
      scale: 4,
      mode: "number",
    }),
    mlGateRoiPct: numeric("ml_gate_roi_pct", {
      precision: 14,
      scale: 4,
      mode: "number",
    }),
    roiLiftPct: numeric("roi_lift_pct", {
      precision: 14,
      scale: 4,
      mode: "number",
    }),
    calibrationError: numeric("calibration_error", {
      precision: 8,
      scale: 6,
      mode: "number",
    }),
    brierScore: numeric("brier_score", {
      precision: 8,
      scale: 6,
      mode: "number",
    }),
    logLoss: numeric("log_loss", {
      precision: 8,
      scale: 6,
      mode: "number",
    }),
    aucRoc: numeric("auc_roc", {
      precision: 8,
      scale: 6,
      mode: "number",
    }),
    scoreMonotonicity: numeric("score_monotonicity", {
      precision: 6,
      scale: 4,
      mode: "number",
    }),
    metrics: jsonb().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    index("ml_learning_snapshots_created_idx").on(t.createdAt.desc()),
    index("ml_learning_snapshots_model_idx").on(
      t.modelVersion,
      t.createdAt.desc(),
    ),
    index("ml_learning_snapshots_verdict_idx").on(
      t.verdict,
      t.createdAt.desc(),
    ),
  ],
);

export type MlLearningSnapshotRow = typeof mlLearningSnapshots.$inferSelect;
export type NewMlLearningSnapshotRow = typeof mlLearningSnapshots.$inferInsert;

export const mlLearningExplanations = pgTable(
  "ml_learning_explanations",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    snapshotHash: text("snapshot_hash").notNull(),
    explanationType: text("explanation_type").notNull().default("operator"),
    provider: text().notNull(),
    model: text().notNull(),
    status: text().notNull().default("success"),
    summary: text(),
    content: jsonb().notNull(),
    promptHash: text("prompt_hash").notNull(),
    generatedAt: timestamp("generated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    uniqueIndex("ml_learning_explanations_unique").on(
      t.snapshotHash,
      t.explanationType,
      t.model,
    ),
    index("ml_learning_explanations_snapshot_idx").on(t.snapshotHash),
    index("ml_learning_explanations_created_idx").on(t.createdAt.desc()),
  ],
);

export type MlLearningExplanationRow =
  typeof mlLearningExplanations.$inferSelect;
export type NewMlLearningExplanationRow =
  typeof mlLearningExplanations.$inferInsert;

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
    cornersHome: integer(),
    cornersAway: integer(),
    htCornersHome: integer(),
    htCornersAway: integer(),
    bookingsHome: integer(),
    bookingsAway: integer(),
    source: text().notNull(), // 'pinnacle-ws' | 'betconstruct' | 'espn' | 'api-football' | 'sofascore' | 'manual'
    confidence: numeric({ precision: 3, scale: 2, mode: "number" }).notNull(),
    sourceUrl: text(),
    fetchedAt: tsNow(),
  },
  (t) => [index("match_scores_status_idx").on(t.status)],
);

export type MatchScoreRow = typeof matchScores.$inferSelect;
export type NewMatchScoreRow = typeof matchScores.$inferInsert;

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
    eventsTotal: integer().notNull().default(0),
    eventsAttempted: integer().notNull().default(0),
    eventsSkippedByBackoff: integer().notNull().default(0),
    eventsResolvedFromCache: integer().notNull().default(0),
    eventsResolvedByEspn: integer().notNull().default(0),
    eventsResolvedBySofaScore: integer().notNull().default(0),
    eventsResolvedByApiFootball: integer().notNull().default(0),
    eventsStillUnresolved: integer().notNull().default(0),
    apiFootballRequestsUsed: integer().notNull().default(0),
    abortedReason: text(),
    error: text(),
    estimatedCostUsd: numeric({ precision: 8, scale: 5, mode: "number" }),
  },
  (t) => [index("settlement_runs_started_idx").on(t.startedAt.desc())],
);

export type SettlementRunRow = typeof settlementRuns.$inferSelect;
export type NewSettlementRunRow = typeof settlementRuns.$inferInsert;

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

export const mlModels = pgTable(
  "ml_models",
  {
    id: text().primaryKey(),
    version: integer().notNull(),
    status: text().notNull().default("training"), // training|validated|deployed|retired|rejected
    modelType: text().notNull().default("lightgbm"),
    trainingSamples: integer().notNull(),
    featureCount: integer().notNull().default(22),
    featureVersion: integer().notNull().default(1),
    featureNamesHash: text(),
    trainingStartedAt: ts().notNull(),
    trainingCompletedAt: ts(),
    trainingStage: text(),
    progressMessage: text(),
    lastHeartbeatAt: ts(),
    estimatedTimeRemainingMs: integer(),
    oosRoiMean: numeric({ precision: 14, scale: 4, mode: "number" }),
    oosAccuracy: numeric({ precision: 6, scale: 4, mode: "number" }),
    oosAucRoc: numeric({ precision: 6, scale: 4, mode: "number" }),
    oosLogLoss: numeric({ precision: 8, scale: 6, mode: "number" }),
    deflatedSharpe: numeric({ precision: 14, scale: 4, mode: "number" }),
    pbo: numeric({ precision: 6, scale: 4, mode: "number" }),
    calibrationError: numeric({ precision: 8, scale: 6, mode: "number" }),
    featureImportance: jsonb(),
    modelArtifactPath: text(),
    onnxBlob: customType<{ data: Buffer; driverData: Buffer }>({
      dataType() {
        return "bytea";
      },
    })("onnx_blob"),
    trainingReport: jsonb(),
    permissionLevel: text().default("observe"), // observe|gate_only|stake_reduce|stake_increase
    rejectionReasons: jsonb().$type<string[] | null>(),
    vertexModelName: text("vertex_model_name"),
    vertexEndpointName: text("vertex_endpoint_name"),
    deployedAt: ts(),
    retiredAt: ts(),
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

export const providerEventSnapshots = pgTable(
  "provider_event_snapshots",
  {
    id: text().primaryKey(),
    provider: text().notNull(),
    providerEventId: text("provider_event_id").notNull(),
    sport: text().notNull().default("football"),
    homeTeamRaw: text("home_team_raw").notNull(),
    awayTeamRaw: text("away_team_raw").notNull(),
    competitionRaw: text("competition_raw").notNull(),
    homeTeamNormalized: text("home_team_normalized").notNull(),
    awayTeamNormalized: text("away_team_normalized").notNull(),
    competitionNormalized: text("competition_normalized").notNull(),
    rawStartTime: text("raw_start_time"),
    parsedKickoff: timestamp("parsed_kickoff", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    parseStrategy: text("parse_strategy").notNull(),
    fetchBatchId: text("fetch_batch_id").notNull(),
    providerMetadata: jsonb("provider_metadata"),
    rawPayload: jsonb("raw_payload"),
    capturedAt: tsNow(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (t) => [
    uniqueIndex("provider_event_snapshots_provider_event_uidx").on(
      t.provider,
      t.providerEventId,
    ),
    index("provider_event_snapshots_provider_idx").on(t.provider),
    index("provider_event_snapshots_kickoff_idx").on(t.parsedKickoff),
    index("provider_event_snapshots_batch_idx").on(t.fetchBatchId),
  ],
);

export type ProviderEventSnapshotRow =
  typeof providerEventSnapshots.$inferSelect;
export type NewProviderEventSnapshotRow =
  typeof providerEventSnapshots.$inferInsert;

export const canonicalEvents = pgTable(
  "canonical_events",
  {
    id: text().primaryKey(),
    sport: text().notNull().default("football"),
    homeTeamCanonical: text("home_team_canonical").notNull(),
    awayTeamCanonical: text("away_team_canonical").notNull(),
    competitionCanonical: text("competition_canonical").notNull(),
    kickoff: ts().notNull(),
    status: text().notNull().default("active"),
    createdByRunId: text("created_by_run_id"),
    createdAt: tsNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("canonical_events_kickoff_idx").on(t.kickoff),
    index("canonical_events_status_idx").on(t.status),
  ],
);

export type CanonicalEventRow = typeof canonicalEvents.$inferSelect;
export type NewCanonicalEventRow = typeof canonicalEvents.$inferInsert;

export const canonicalEventMembers = pgTable(
  "canonical_event_members",
  {
    id: text().primaryKey(),
    canonicalEventId: text("canonical_event_id").notNull(),
    snapshotId: text("snapshot_id").notNull(),
    provider: text().notNull(),
    providerEventId: text("provider_event_id").notNull(),
    decisionId: text("decision_id"),
    joinedAt: tsNow(),
  },
  (t) => [
    uniqueIndex("canonical_event_members_snapshot_uidx").on(t.snapshotId),
    uniqueIndex("canonical_event_members_provider_event_uidx").on(
      t.provider,
      t.providerEventId,
    ),
    index("canonical_event_members_canonical_idx").on(t.canonicalEventId),
  ],
);

export type CanonicalEventMemberRow = typeof canonicalEventMembers.$inferSelect;
export type NewCanonicalEventMemberRow =
  typeof canonicalEventMembers.$inferInsert;

export const matcherCandidates = pgTable(
  "matcher_candidates",
  {
    id: text().primaryKey(),
    runId: text("run_id").notNull(),
    snapshotAId: text("snapshot_a_id").notNull(),
    snapshotBId: text("snapshot_b_id").notNull(),
    providerA: text("provider_a").notNull(),
    providerB: text("provider_b").notNull(),
    candidateKey: text("candidate_key").notNull().unique(),
    shapeFingerprint: text("shape_fingerprint").notNull(),
    scoringVersion: text("scoring_version").notNull(),
    groundingVersion: text("grounding_version").notNull(),
    status: text().notNull().default("generated"),
    hardBlockers: jsonb("hard_blockers").notNull(),
    reasons: jsonb()
      .notNull()
      .default(sql`'[]'::jsonb`),
    scoreBreakdown: jsonb("score_breakdown"),
    combinedScore: real("combined_score"),
    sourceStage: text("source_stage").notNull().default("candidate_generation"),
    createdAt: tsNow(),
  },
  (t) => [
    index("matcher_candidates_run_idx").on(t.runId),
    index("matcher_candidates_status_idx").on(t.status),
    index("matcher_candidates_provider_pair_idx").on(t.providerA, t.providerB),
    index("matcher_candidates_shape_idx").on(t.shapeFingerprint),
  ],
);

export type MatcherCandidateRow = typeof matcherCandidates.$inferSelect;
export type NewMatcherCandidateRow = typeof matcherCandidates.$inferInsert;

export const matcherDecisions = pgTable(
  "matcher_decisions",
  {
    id: text().primaryKey(),
    runId: text("run_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    decision: text().notNull(),
    decisionStage: text("decision_stage").notNull(),
    confidence: real().notNull(),
    confidenceBand: text("confidence_band").notNull(),
    final: boolean().notNull().default(false),
    dryRun: boolean("dry_run").notNull().default(false),
    reasonCode: text("reason_code").notNull(),
    reasonSummary: text("reason_summary").notNull(),
    groundedDecision: text("grounded_decision"),
    groundedConfidence: real("grounded_confidence"),
    hardBlockers: jsonb("hard_blockers").notNull(),
    scoreBreakdown: jsonb("score_breakdown").notNull(),
    canonicalEventId: text("canonical_event_id"),
    createdAt: tsNow(),
  },
  (t) => [
    index("matcher_decisions_run_idx").on(t.runId),
    index("matcher_decisions_candidate_idx").on(t.candidateId),
    index("matcher_decisions_stage_idx").on(t.decisionStage),
    index("matcher_decisions_created_idx").on(t.createdAt.desc()),
  ],
);

export type MatcherDecisionRow = typeof matcherDecisions.$inferSelect;
export type NewMatcherDecisionRow = typeof matcherDecisions.$inferInsert;

export const matcherImpactDaily = pgTable(
  "matcher_impact_daily",
  {
    id: text().primaryKey(),
    day: text().notNull(),
    providerPair: text("provider_pair").notNull(),
    sourceStage: text("source_stage").notNull(),
    confidenceBand: text("confidence_band").notNull(),
    activeMatchedEvents: integer("active_matched_events").notNull().default(0),
    exactDeterministicMatches: integer("exact_deterministic_matches")
      .notNull()
      .default(0),
    matcherHelpedMatches: integer("matcher_helped_matches")
      .notNull()
      .default(0),
    deepseekResolved: integer("deepseek_resolved").notNull().default(0),
    reviewAvoided: integer("review_avoided").notNull().default(0),
    dryRunMatches: integer("dry_run_matches").notNull().default(0),
    examples: jsonb(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("matcher_impact_daily_rollup_uidx").on(
      t.day,
      t.providerPair,
      t.sourceStage,
      t.confidenceBand,
    ),
    index("matcher_impact_daily_day_idx").on(t.day),
  ],
);

export type MatcherImpactDailyRow = typeof matcherImpactDaily.$inferSelect;
export type NewMatcherImpactDailyRow = typeof matcherImpactDaily.$inferInsert;

export const eventMatcherRunJobs = pgTable(
  "event_matcher_run_jobs",
  {
    id: text().primaryKey(),
    status: text().notNull().default("queued"),
    trigger: text().notNull(),
    mode: text().notNull().default("apply"),
    decisionIds: jsonb("decision_ids").$type<string[]>().notNull(),
    useDeepSeek: boolean("use_deepseek"),
    summary: jsonb().$type<Record<string, unknown> | null>(),
    errorMessage: text("error_message"),
    createdAt: tsNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    finishedAt: timestamp("finished_at", {
      withTimezone: true,
      mode: "string",
    }),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [
    index("event_matcher_run_jobs_status_idx").on(t.status),
    index("event_matcher_run_jobs_created_idx").on(t.createdAt.desc()),
  ],
);

export type EventMatcherRunJobRow = typeof eventMatcherRunJobs.$inferSelect;
export type NewEventMatcherRunJobRow = typeof eventMatcherRunJobs.$inferInsert;

export const eventMatcherRunJobEvents = pgTable(
  "event_matcher_run_job_events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    jobId: text("job_id").notNull(),
    phase: text().notNull(),
    event: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: tsNow(),
  },
  (t) => [
    index("event_matcher_run_job_events_job_idx").on(t.jobId),
    index("event_matcher_run_job_events_created_idx").on(t.createdAt),
  ],
);

export type EventMatcherRunJobEventRow =
  typeof eventMatcherRunJobEvents.$inferSelect;
export type NewEventMatcherRunJobEventRow =
  typeof eventMatcherRunJobEvents.$inferInsert;

export const eventMatcherSchedulerSettings = pgTable(
  "event_matcher_scheduler_settings",
  {
    id: integer().primaryKey().default(1),
    enabled: boolean().notNull().default(true),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    useDeepSeek: boolean("use_deepseek").notNull().default(true),
    updatedAt: tsNow(),
  },
);

export type EventMatcherSchedulerSettingsRow =
  typeof eventMatcherSchedulerSettings.$inferSelect;
export type NewEventMatcherSchedulerSettingsRow =
  typeof eventMatcherSchedulerSettings.$inferInsert;

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

export const aiSearchLogs = pgTable(
  "ai_search_logs",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    createdAt: tsNow(),
    endpoint: text().notNull(),
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

export const aiActivityLog = pgTable(
  "ai_activity_log",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    createdAt: tsNow(),
    system: text().notNull(),
    trigger: text().notNull().default("manual"),
    status: text().notNull(),
    model: text(),
    itemCount: integer(),
    durationMs: integer(),
    costUsd: numeric({ precision: 8, scale: 5, mode: "number" }),
    summary: text(),
    error: text(),
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

export const competitionTiers = pgTable("competition_tiers", {
  name: text().primaryKey(),
  tier: integer().notNull(),
  classifiedAt: ts().notNull().defaultNow(),
});

export type CompetitionTierRow = typeof competitionTiers.$inferSelect;

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
    featureVersion: integer().notNull().default(1),
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

export const aiProviderConfig = pgTable("ai_provider_config", {
  name: text().primaryKey(),

  enabled: boolean().notNull().default(true),
  disabledReason: text("disabled_reason"),

  modelId: text("model_id"),
  tier: text(), // "lite" | "flash" | "pro"
  label: text(),
  tagline: text(),
  engineType: text("engine_type"), // "llm" | "search"

  totalUsageCount: bigint({ mode: "number" }).notNull().default(0),
  monthlyUsageCount: integer("monthly_usage_count").notNull().default(0),
  monthlyLimit: integer("monthly_limit"), // null = unlimited
  lastResetAt: ts().notNull().defaultNow(),

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
  providerEventSnapshots,
  canonicalEvents,
  canonicalEventMembers,
  matcherCandidates,
  matcherDecisions,
  matcherImpactDaily,
  eventMatcherRunJobs,
  eventMatcherRunJobEvents,
  eventMatcherSchedulerSettings,
  telegramCommandHistory,
  mlModels,
  aiSearchLogs,
  aiActivityLog,
  competitionTiers,
  competitionEnrichments,
  mlTrainingExamples,
  mlLearningSnapshots,
  mlLearningExplanations,
  aiProviderConfig,
  aiLogs,
};
