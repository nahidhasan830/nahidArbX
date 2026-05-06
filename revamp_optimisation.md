# Final ML Optimizer Plan

  ## Phase 0: Cleanup + Stabilization Module

  Goal: Get the current partial implementation back to a coherent, buildable state.

  Context: The code currently says FEATURE_COUNT = 25, but DB rows are only 21/22/23 features. competition-
  tier.ts imports DB at module load, which breaks feature tests without DATABASE_URL. UI catalog still has 21
  features.

  Implement:

  - Fix lib/ml/competition-tier.ts so getCompetitionTier() is pure sync/cache-only and does not import DB at
    module load.
  - Fix /grounded-query request body to use question, not query.
  - Update lib/shared/constants.ts: ML_FEATURE_COUNT = 25.
  - Finish lib/ml/feature-catalog.ts with all 25 features.
  - Fix stale comments in TS/Python/UI files.
  - Fix tests/unit/ml/features.test.ts indexes for vig_pct, competition_tier, etc.
  - Add migration to normalize old feature arrays to 25.

  Decision: Old rows should be padded as:

  - competition_tier = 1
  - hours_since_line_opened = 0
  - sharp_soft_spread = 0
  - num_markets_same_event = 1

  Not all zeros. Tier 0 and event count 0 are fake values.

  Validation:

  - npx vitest run tests/unit/ml/features.test.ts
  - npm run build
  - npm run lint

  ———

  ## Phase 1: Feature Contract + Versioning Module

  Goal: Make feature vectors auditable and impossible to silently drift.

  Implement:

  - Add ML_FEATURE_VERSION = 2.
  - Add DB columns or metadata:
      - ml_feature_version
      - ml_feature_count
      - ml_feature_names_hash
  - Store this for every generated feature vector.
  - Add a shared contract test:
      - TS FEATURE_NAMES
      - Python FEATURE_NAMES
      - UI FEATURE_CATALOG
      - ONNX metadata

  Files:

  - lib/ml/features.ts
  - lib/ml/feature-catalog.ts
  - services/optimizer/app/feature_names.py
  - services/optimizer/app/exporter.py
  - lib/db/schema.ts
  - new migration

  Decision: Training should reject mixed feature versions unless an explicit migration/adaptor exists.

  ———

  ## Phase 2: AI Competition Enrichment Module

  Goal: Use AI for richer market-efficiency context without slowing detection.

  Provider decision:

  - Primary: HuggingFace
  - Fallback: Groq
  - Search grounding: only when competition is unknown, ambiguous, or confidence is low
  - Gemini: not used

  Replace simple competition_tier with cached enrichment:

  - tier: 1 | 2 | 3
  - market_efficiency_score: 0-100
  - region
  - country
  - competition_level: top_domestic | lower_domestic | continental | cup | friendly | youth | women | unknown
  - confidence: 0-100
  - model
  - provider
  - prompt_version
  - sources
  - raw_response
  - classified_at

  Runtime feature still uses numeric fields only:

  - competition_tier
  - later optional: market_efficiency_score

  Files:

  - lib/ml/competition-enrichment.ts
  - lib/db/schema.ts
  - migration for competition_enrichments
  - engine boot periodic warmer

  Decision: Detection loop never waits for AI. Unknown competition defaults to tier 1, confidence 0, then
  improves after background enrichment.

  ———

  ## Phase 3: Runtime Feature Extraction Module

  Goal: Make feature extraction fast, deterministic, and cache-only.

  Implement:

  - Keep 25 features for now.
  - Make extractFeatures() fully synchronous.
  - Pass num_markets_same_event from detector.
  - Clamp impossible values:
      - negative hours_since_line_opened => 0
      - non-finite spread => 0
      - event count minimum => 1
  - Add feature quality counters:
      - missing event
      - missing competition enrichment
      - missing history
      - missing vig

  Important improvement:
  Do not treat market_type_encoded as a meaningful ordinal long term. Keep for compatibility now, but Phase 6
  should either one-hot it or mark it categorical in LightGBM.

  Files:

  - lib/ml/features.ts
  - lib/background/reactive-detector.ts
  - tests/unit/ml/features.test.ts

  ———

  ## Phase 4: ML Training Example Store Module

  Goal: Stop overloading bets as both operational state and ML training data.

  Create new table: ml_training_examples

  Fields:

  - id
  - source_bet_id
  - example_type: settled_detected | placed_settled | near_miss | shadow_scored
  - event_id
  - family_id
  - atom_id
  - features
  - feature_version
  - label
  - label_source
  - sample_weight
  - outcome
  - pnl
  - clv_pct
  - created_at
  - settled_at

  Decision: Do not add outcome='near_miss' to bets. That would pollute settlement, history, dashboard counts,
  and filters.

  Files:

  - new lib/ml/training-example-writer.ts
  - new migration
  - lib/background/reactive-detector.ts
  - services/optimizer/app/loader.py

  ———

  ## Phase 5: Labeling + Weighting Module

  Goal: Train on value quality, not just “did this bet win.”

  Current data gives about:

  - positive with features: 446
  - negative with features: 629
  - class ratio is usable, not extreme

  Labels:

  - won, half_won => positive
  - lost, half_lost => negative
  - void => excluded
  - near_miss => negative, low weight
  - CLV-positive can be auxiliary metadata, not the first primary label

  Weights:

  - settled real/simulated examples: 1.0+
  - near-miss examples: 0.35-0.5
  - high absolute PnL examples: larger weight
  - half outcomes: half weight or normalized by actual return

  Implement:

  - Add sample_weights to TrainingData.
  - Pass sample_weight to LightGBM.
  - Add scale_pos_weight, but computed conservatively.

  Decision: Because placed = 0, treat current data as simulated detected-bet training, not proven real-money
  placement training.

  ———

  ## Phase 6: Training + Calibration Module

  Goal: Make the model robust for small/medium betting datasets.

  LightGBM defaults:

  - num_leaves: 15
  - max_depth: 5
  - learning_rate: 0.03
  - n_estimators: 500
  - min_child_samples: adaptive
  - colsample_bytree: 0.6
  - regularization stays on

  Add validation metrics:

  - AUC
  - log loss
  - calibration error
  - OOS ROI
  - OOS CLV
  - score bucket ROI
  - score bucket sample count
  - monotonicity of buckets

  Score buckets:

  - <0.4
  - 0.4-0.5
  - 0.5-0.6
  - 0.6-0.7
  - 0.7-0.8
  - >0.8

  Decision: A model is only useful if higher score buckets show better ROI/CLV. AUC alone is not enough.

  Files:

  - services/optimizer/app/loader.py
  - services/optimizer/app/trainer.py
  - services/optimizer/app/scoring.py
  - services/optimizer/tests/*

  ———

  ## Phase 7: Model Deployment Gate Module

  Goal: Prevent bad or overfit models from reaching runtime.

  Deployment requirements for first shadow model:

  - at least 1000 valid settled examples after feature normalization
  - feature version matches runtime
  - no feature length drift
  - AUC above baseline
  - bucket ROI/CLV is directionally monotonic
  - no severe calibration failure

  Runtime permission levels:

  - shadow: score and log only
  - gate_only: can skip low-score bets
  - stake_reduce: can reduce stake on weak bets
  - stake_increase: disabled until enough real placed-settled evidence exists

  Decision for this repo now: first deployed model should be shadow or gate_only, not stake-increasing.

  ———

  ## Phase 8: Runtime Scoring + Staking Module

  Goal: Make ML behavior explicit and safe.

  Implement dual mode:

  - No model loaded: exact pre-ML behavior
  - Shadow model: persist ml_score, do not affect placement
  - Gate-only model: skip below threshold
  - Stake-reduce model: reduce weak scores, never increase base Kelly
  - Stake-increase model: future only

  Fix current bug:
  Right now no-model scoring returns 1.0, then staking applies a multiplier. That changes behavior before ML
  exists. Fix this.

  Files:

  - lib/ml/scorer.ts
  - lib/ml/staker.ts
  - lib/betting/auto-placer.ts
  - components/lab/ml/MLPipelineDashboard.tsx

  Decision: Until there are placed-settled rows, ML may gate or reduce only. No stake increase.

  ———

  ## Phase 9: Near-Miss + Shadow Data Module

  Goal: Reduce survival bias without contaminating operational bets.

  Collect:

  - 0 < EV < MIN_EV_PCT
  - cap per detection pass
  - rate limit per deterministic bet key
  - store in ml_training_examples

  Also store shadow-scored active value bets:

  - score at detection
  - later attach outcome/CLV when settled

  Decision: Near-misses should be lower-weight negatives, not equal to lost bets.

  ———

  ## Phase 10: UI + Diagnostics Module ✅ DONE

  Goal: Make ML explainable and operationally visible.

  Implemented:

  - Feature contract status (version distribution, length distribution, hash)
  - Feature version coverage with drift warnings
  - Enrichment cache coverage with progress bar
  - Training sample composition (by type and label)
  - Score bucket ROI/CLV/Win% performance table
  - Model permission level and scoring mode
  - Shadow/gate/stake mode indicator
  - Rejected model reasons with metrics summary
  - Feature Inspector shows version, count, score placement effect
  - Dead code cleanup (ModelSection, ScoringSection, useScorer, Metric removed)

  Files modified:

  - app/api/ml/pipeline/route.ts (extended with Phase 10 diagnostics)
  - components/lab/ml/MLPipelineDashboard.tsx (new diagnostic sections)
  - components/lab/ml/MLModelStatus.tsx (dead code removal)
  - components/bets-history/FeatureInspectorDialog.tsx (version + placement effect)
  - components/bets-history/BetsHistoryTable.tsx (pass new props)

  ———

  ## Phase 11: Operations + Verification Module ✅ DONE

  Goal: Add repeatable checks so drift is caught quickly.

  Implemented:

  - `scripts/ml-verify.ts` — comprehensive verification script
    - Feature length distribution (DB)
    - Feature version distribution (DB)
    - TS/Python/UI feature contract match (static)
    - Feature names hash verification (static)
    - Enrichment cache coverage (DB)
    - Trainable sample count + composition (DB)
    - Score bucket ROI/CLV/win% performance (DB)
    - Latest model metadata + deployed model status (DB)
    - Outcome distribution sanity check (DB)
  - `tests/unit/ml/operations-verify.test.ts` — 13 Vitest contract tests
    - Feature contract alignment (TS ↔ Python ↔ UI catalog)
    - Feature catalog completeness (all fields, categories, formats)
    - Cross-pipeline consistency (ONNX exporter metadata, hash)
  - `npm run ml:verify` — full DB + contract verification
  - `npm run ml:verify:contract` — contract-only (no DB needed, CI-safe)
  - Fixed `tests/unit/settle/apply-outcomes.test.ts` — added missing mocks
    for `@/lib/db/client` and `@/lib/ml/training-example-writer` (broken
    since Phase 9 added training hooks to apply-outcomes)

  Files modified:

  - scripts/ml-verify.ts (new)
  - tests/unit/ml/operations-verify.test.ts (new)
  - package.json (added ml:verify, ml:verify:contract scripts)
  - tests/unit/settle/apply-outcomes.test.ts (fixed broken mocks)

  Required after each implementation phase:

  - npm run build
  - npm run lint
  - npx vitest run
  - cd services/optimizer && source .venv/bin/activate && python -m pytest tests/ -v

  Manual DB sanity checks:

  SELECT array_length(ml_features, 1), count(*)
  FROM bets
  WHERE ml_features IS NOT NULL
  GROUP BY 1
  ORDER BY 1;

  SELECT outcome, count(*), count(*) FILTER (WHERE ml_features IS NOT NULL)
  FROM bets
  GROUP BY outcome
  ORDER BY count(*) DESC;

  # Final Decisions

  Use HuggingFace primary, Groq fallback, no Gemini.

  Use AI heavily for enrichment, but never in the detection hot path.

  Train first model from current historical data only after feature vectors are normalized to 25 and versioned.

  Initial ML runtime mode should be shadow/gate-only. No stake increases until the system has real placed-
  settled evidence or strong shadow validation over future data.

  Near-misses should use a new ML examples table, not bets.outcome.

  The next implementation should be Phase 0 only. It is the foundation; without it, later phases will compound
  the current contract drift.