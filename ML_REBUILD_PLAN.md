# ML Model Rebuild Plan

## ✅ Implementation Status: COMPLETED (2026-05-20)

All phases (1-4) have been implemented and committed. The model is ready for retraining.

**Commit:** `ecd0134` - feat(ml): fix feature leakage and improve model training

---

## Problem Summary

Current model has fatal feature leakage and wrong objective:

- **Feature leakage**: `ev_pct`, `kelly_fraction`, `implied_prob_gap` are all derived from the target
- **Wrong objective**: Predicting P(win) but deciding on EV
- **Label mismatch**: Binary labels don't capture return magnitude
- **Calibration confusion**: Calibrated for P(win), not for EV

## Recommended Approach: Weighted Binary Classification

### ✅ Phase 1: Fix Feature Leakage (COMPLETED)

**Removed features:**

- `ev_pct` (index 0) — this IS the target variable
- `kelly_fraction_raw` (index 19) — derived from EV
- `implied_prob_gap` (index 4) — EV in probability space

**Kept features:**

- `sharp_true_prob` (index 0) — OK, this is the sharp market's opinion
- `soft_odds` (index 1) — OK, this is what we're betting at
- `adjusted_soft_odds` (index 2) — OK, commission-adjusted
- All movement/history features (3-16) — OK, these are market dynamics
- `vig_pct` (index 17) — OK, market efficiency signal
- `competition_tier` (index 18) — OK, quality signal
- `hours_since_line_opened` (index 19) — OK, timing signal
- `sharp_soft_spread` (index 20) — OK, this is the raw spread, not EV
- `num_markets_same_event` (index 21) — OK, liquidity signal

**New feature count: 22** (down from 25)

**Files changed:**

- `lib/ml/features.ts` — Updated feature extraction
- `lib/ml/feature-contract.ts` — Updated feature names
- `lib/shared/constants.ts` — Bumped `ML_FEATURE_COUNT` to 22, `ML_FEATURE_VERSION` to 3
- `services/optimizer/app/feature_names.py` — Updated Python contract

### ✅ Phase 2: Fix Sample Weighting (COMPLETED)

**Old (wrong):**

```python
# Weights by PnL magnitude with log boost
weights[i] *= _pnl_boost(abs(pnl))
```

**New (correct):**

```python
# Weight by absolute unit return (economic impact)
weights = np.abs(unit_returns)
# Clip extreme outliers
weights = np.clip(weights, 0.1, 10.0)
```

**Rationale:** A bet that wins 5 units should have 5x the influence of a bet that wins 1 unit. Previous PnL boost was too weak (log scale).

**Files changed:**

- `services/optimizer/app/loader.py` — Updated `_derive_sample_weights()`, removed `_pnl_boost()`

### ✅ Phase 3: Fix Objective Alignment (COMPLETED)

**Implementation:**

```python
# Model predicts P(win), weighted by unit return
# Then policy uses: edge = P(win) * odds - 1
# But now P(win) is calibrated for EV, not just win rate
```

**Key insight:** By weighting training samples by `|unit_return|`, the model learns to predict P(win) in a way that's useful for EV decisions, not just accuracy.

**Achieved through Phase 2 sample weighting changes.**

### ✅ Phase 4: Simplify Policy Threshold (COMPLETED)

**Old (complex):**

- Search 7 thresholds (0%, 2%, 5%, 8%, 10%, 15%, 20%)
- Pick best by Sharpe ratio
- This was overfitting to the validation set

**New (simple):**

- Single threshold: **2%** (matches MIN_EV_PCT from detector)
- Rationale: Model should learn to beat the baseline, not find the best threshold

**Files changed:**

- `services/optimizer/app/policy.py` — Set `POLICY_EDGE_THRESHOLD_PCT = 2.0`, replaced `select_policy_threshold()` with `compute_policy_threshold_stats()`, updated `PolicyThresholdResult` dataclass, fixed `simple_rule_mask()` to compute EV% from features
- `services/optimizer/app/trainer.py` — Updated to use `compute_policy_threshold_stats()`, simplified DSR calculation

### ✅ Phase 5: Update Monotone Constraints (COMPLETED)

**Files changed:**

- `services/optimizer/app/trainer.py` — Adjusted `monotone_constraints` array for 22 features, all set to 0 (unconstrained)

### Phase 6: Add Direct EV Features (OPTIONAL - NOT IMPLEMENTED)

If you want to give the model more signal about EV without leaking the answer:

**Potential features to add:**

- `odds_value_ratio = soft_odds / (1 / sharp_true_prob)` — how much better is soft vs sharp?
- `vig_adjusted_edge = (sharp_true_prob * adjusted_soft_odds - 1) * 100` — EV after commission
- `market_efficiency = vig_pct / competition_tier` — vig relative to league quality

**Rationale:** These are transformations of existing features that make EV relationships more explicit without leaking the detector's EV calculation.

**Status:** Not implemented. Evaluate after retraining with current 22 features.

---

## ✅ Implementation Summary

### Files Modified

**TypeScript:**

1. `lib/ml/features.ts` — Removed 3 leaked features, updated to 22-feature vector
2. `lib/ml/feature-contract.ts` — Updated feature names list
3. `lib/shared/constants.ts` — Bumped feature count and version

**Python:**

1. `services/optimizer/app/feature_names.py` — Updated feature contract
2. `services/optimizer/app/loader.py` — Fixed sample weighting
3. `services/optimizer/app/policy.py` — Simplified policy threshold
4. `services/optimizer/app/trainer.py` — Updated monotone constraints and threshold logic

### Key Changes

1. **Feature count:** 25 → 22
2. **Feature version:** 2 → 3
3. **Sample weighting:** Log-scale PnL boost → Direct |unit_return| weighting
4. **Policy threshold:** Searched (7 candidates) → Fixed (2%)
5. **Monotone constraints:** Updated for 22 features, all unconstrained

---

    /* 3  tick_count        */ sharpHistory?.totalTicks ?? 0,
    /* 4  time_to_kickoff   */ timeToKickoffMin,
    /* 5  movement_pct_sharp */ sharpMovement?.changePct ?? 0,
    /* 6  movement_pct_soft */ softMovement?.changePct ?? 0,
    /* 7  steam_move_sharp  */ detectSteamMove(...) ? 1 : 0,
    /* 8  steam_move_soft   */ detectSteamMove(...) ? 1 : 0,
    /* 9  sharp_direction   */ encodeDirection(sharpMovement?.direction),
    /* 10 soft_direction    */ encodeDirection(softMovement?.direction),
    /* 11 convergence_rate  */ computeConvergenceRate(...),
    /* 12 tick_velocity     */ tickVelocity,
    /* 13 provider_count    */ getAllOddsForAtom(...).size,
    /* 14 opening_sharp_odds */ sharpHistory?.openingOdds ?? 0,
    /* 15 market_type_encoded */ marketTypeEncoded,
    /* 16 is_asian_line     */ isAsianLine,
    /* 17 vig_pct           */ vigData?.vigPct ?? 0,
    /* 18 competition_tier  */ getCompetitionTier(...),
    /* 19 hours_since_line_opened */ hoursSinceLineOpened,
    /* 20 sharp_soft_spread */ safeSharpSoftSpread,
    /* 21 num_markets_same_event */ safeMarketCount,

];

return features.map(v => Math.round((Number.isFinite(v) ? v : 0) \* 10000) / 10000);
}

````

### 2. Update Feature Contract (Python)

**File:** `services/optimizer/app/feature_names.py`

```python
FEATURE_VERSION = 3  # Bump version
FEATURE_COUNT = 22   # Down from 25

FEATURE_NAMES = (
    "sharp_true_prob",
    "soft_odds",
    "adjusted_soft_odds",
    "tick_count",
    "time_to_kickoff_min",
    "movement_pct_sharp",
    "movement_pct_soft",
    "steam_move_sharp",
    "steam_move_soft",
    "sharp_direction",
    "soft_direction",
    "convergence_rate",
    "tick_velocity",
    "provider_count",
    "opening_sharp_odds",
    "market_type_encoded",
    "is_asian_line",
    "vig_pct",
    "competition_tier",
    "hours_since_line_opened",
    "sharp_soft_spread",
    "num_markets_same_event",
)
````

### 3. Update Sample Weighting (Python)

**File:** `services/optimizer/app/loader.py`

```python
def _derive_sample_weights(rows: list[dict[str, Any]]) -> np.ndarray:
    """Weight by absolute unit return (economic impact)."""
    weights = np.ones(len(rows), dtype=np.float64)

    for i, r in enumerate(rows):
        outcome = r.get("outcome", "")
        soft_odds = float(r.get("soft_odds") or 0)
        commission_pct = float(r.get("soft_commission_pct") or 0)

        unit_return = _compute_unit_return(outcome, soft_odds, commission_pct)
        if unit_return is not None:
            # Weight by absolute return magnitude
            weights[i] = abs(unit_return)

        # Half outcomes still get reduced weight
        if outcome in ("half_won", "half_lost"):
            weights[i] *= 0.5

    # Clip extreme outliers (optional)
    weights = np.clip(weights, 0.1, 10.0)

    return weights
```

### 4. Simplify Policy Threshold (Python)

**File:** `services/optimizer/app/policy.py`

```python
# Remove threshold search — use fixed 2% threshold
POLICY_EDGE_THRESHOLD_PCT = 2.0  # Match MIN_EV_PCT from detector

# Remove POLICY_EDGE_THRESHOLD_CANDIDATES_PCT
# Remove select_policy_threshold() function
```

### 5. Update Monotone Constraints (Python)

**File:** `services/optimizer/app/trainer.py`

```python
# Update for 22 features (removed ev_pct, implied_prob_gap, kelly_fraction)
DEFAULT_LGBM_PARAMS = {
    # ... existing params ...
    "monotone_constraints": [
        0,   # 0:  sharp_true_prob (relaxed — can be non-monotonic with odds)
        0,   # 1:  soft_odds
        0,   # 2:  adjusted_soft_odds
        0,   # 3:  tick_count
        0,   # 4:  time_to_kickoff_min
        0,   # 5:  movement_pct_sharp
        0,   # 6:  movement_pct_soft
        0,   # 7:  steam_move_sharp
        0,   # 8:  steam_move_soft
        0,   # 9:  sharp_direction
        0,   # 10: soft_direction
        0,   # 11: convergence_rate
        0,   # 12: tick_velocity
        0,   # 13: provider_count
        0,   # 14: opening_sharp_odds
        0,   # 15: market_type_encoded
        0,   # 16: is_asian_line
        0,   # 17: vig_pct
        0,   # 18: competition_tier
        0,   # 19: hours_since_line_opened
        0,   # 20: sharp_soft_spread
        0,   # 21: num_markets_same_event
    ],
}
```

---

## Migration Path

### Step 1: Backfill Features (One-Time) - TODO

The engine will automatically recompute features for new value bets using the new 22-feature contract (version 3). Existing bets in the database with old features (version 2) will be ignored during training.

**Option A: Natural rollover (recommended)**

- Wait for new bets to accumulate with version 3 features
- Training will use only version 3 bets (filtered by `ml_feature_version = 3`)
- Old version 2 bets will be excluded automatically

**Option B: Force recompute (if you need historical data)**

```sql
-- Mark old features as stale
UPDATE bets
SET ml_feature_version = 2, ml_features = NULL
WHERE ml_feature_version = 2;

-- Engine will recompute features on next detection pass
-- (This will only work for bets still in the value-bet detection window)
```

### Step 2: Retrain Model - TODO

```bash
curl -X POST http://localhost:3000/api/ml/retrain
```

This will:

1. Load training data with new 22-feature contract (version 3 only)
2. Apply new sample weighting (by |unit_return|)
3. Train with fixed 2% threshold
4. Deploy to Vertex AI

**Expected behavior:**

- Training will only use bets with `ml_feature_version = 3`
- Minimum 200 samples required (ML_COLD_START_THRESHOLD)
- If insufficient version 3 samples, training will be rejected

### Step 3: Monitor Performance - TODO

**Key metrics to watch:**

- **DSR (Deflated Sharpe Ratio)**: Should improve if model is learning real signal
- **PBO (Probability of Backtest Overfitting)**: Should stay < 0.5
- **Policy ROI vs Simple ROI**: Model should beat the baseline (3%+ EV, liquid markets)
- **Outer holdout AUC**: Should be > 0.55 (random is 0.5)

**Red flags:**

- DSR < 0.5 → Model is not learning useful signal
- PBO > 0.7 → Model is overfitting
- Policy ROI < Simple ROI → Model is worse than baseline

---

## Expected Improvements

### Before (Current Model)

- **Feature leakage**: Model echoes back `ev_pct` → artificially high training AUC
- **Wrong objective**: Predicts P(win), not EV → poor deployment performance
- **Weak weighting**: Log-scale PnL boost → big wins underweighted

### After (Fixed Model)

- **No leakage**: Model learns from market dynamics, not the answer
- **Aligned objective**: Weighted by |unit_return| → learns EV-relevant patterns
- **Strong weighting**: Linear return weighting → big wins properly weighted

**Realistic expectations:**

- Training AUC will **drop** (0.75 → 0.60) because we removed the cheat codes
- Deployment ROI will **improve** because the model is solving the right problem
- DSR should be > 1.0 if the model is learning real signal

---

## Alternative: Direct EV Regression

If weighted classification doesn't work, try regression:

```python
# Target: continuous unit_return
model = lgb.LGBMRegressor(
    objective="huber",  # robust to outliers
    alpha=0.9,
    ...
)

# Inference
predicted_ev = model.predict(features)
place_mask = predicted_ev > 0.02  # 2% threshold
```

**When to use:**

- If classification model's P(win) → EV conversion is unstable
- If you want direct EV predictions (more interpretable)
- If you have enough data (regression needs more samples than classification)

---

## Questions to Answer

1. **How much training data do you have?**
   - Need at least 500 settled bets for classification
   - Need at least 2000 for regression

2. **What's your current model's training AUC?**
   - If it's > 0.80, that's suspicious (likely leakage)
   - If it's < 0.55, model isn't learning anything

3. **What's your deployment ROI vs baseline ROI?**
   - If model ROI < baseline ROI, model is harmful
   - If model ROI ≈ baseline ROI, model is useless
   - If model ROI > baseline ROI, model is working (but check for leakage)

4. **Are you seeing any of these symptoms?**
   - High training AUC, low deployment ROI → leakage
   - Model always predicts high P(win) → label imbalance
   - Model ignores movement features → they're not predictive

---

## UI Updates & Monitoring

### Phase 6: Visual Monitoring Dashboard

**Goal:** See at a glance if the model is working correctly and improving over time.

#### 1. Feature Health Dashboard

**New page:** `/lab/ml/features`

**Purpose:** Catch feature extraction bugs before they poison training data.

**Components:**

**A. Feature Distribution Heatmap**

```typescript
// Show distribution of each feature across all live value bets
// Color-coded: green = healthy, yellow = suspicious, red = broken

interface FeatureHealth {
  featureName: string;
  mean: number;
  std: number;
  min: number;
  max: number;
  nullPct: number;
  zeroPct: number;
  status: "healthy" | "suspicious" | "broken";
  issue?: string;
}

// Red flags:
// - nullPct > 10% → extraction failing
// - zeroPct > 80% → feature always zero (cold history?)
// - std = 0 → feature not varying (stuck?)
// - min = max → feature constant
```

**B. Feature Correlation Matrix**

```typescript
// Heatmap showing correlation between features
// Catch redundant features (correlation > 0.95)
// Catch leakage (feature correlates 1.0 with outcome)
```

**C. Feature Drift Detector**

```typescript
// Compare feature distributions: training set vs live bets
// Alert when live distribution diverges from training
// Uses KL divergence or Kolmogorov-Smirnov test

interface FeatureDrift {
  featureName: string;
  trainingMean: number;
  liveMean: number;
  driftScore: number; // 0-1, higher = more drift
  alert: boolean; // true if drift > threshold
}
```

**D. Feature Warmup Tracker**

```typescript
// Track how many bets have cold features (tick_count < 3)
// Show warmup progress after engine restart

interface WarmupStatus {
  totalBets: number;
  warmBets: number;
  coldBets: number;
  warmupPct: number;
  avgTickCount: number;
  estimatedWarmupTimeMin: number;
}
```

**Implementation:**

```typescript
// New API endpoint
// GET /api/ml/features/health

export async function GET() {
  const valueBets = getValueBets();
  const features = valueBets.map((vb) => extractFeatures(vb));

  const health = FEATURE_NAMES.map((name, idx) => {
    const values = features.map((f) => f[idx]).filter((v) => v !== null);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(
      values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
    );
    const nullPct = ((features.length - values.length) / features.length) * 100;
    const zeroPct =
      (values.filter((v) => v === 0).length / values.length) * 100;

    // Detect issues
    let status: "healthy" | "suspicious" | "broken" = "healthy";
    let issue: string | undefined;

    if (nullPct > 10) {
      status = "broken";
      issue = `${nullPct.toFixed(1)}% null values`;
    } else if (std === 0 && mean !== 0) {
      status = "broken";
      issue = "Feature is constant";
    } else if (zeroPct > 80) {
      status = "suspicious";
      issue = `${zeroPct.toFixed(1)}% zero values`;
    }

    return { featureName: name, mean, std, nullPct, zeroPct, status, issue };
  });

  return Response.json({ health });
}
```

---

#### 2. Model Performance Tracker

**New tab on `/lab/ml`:** "Performance History"

**Purpose:** Track model performance over time to see if it's improving or degrading.

**Components:**

**A. Time-Series Charts**

```typescript
// Chart 1: ROI over time (daily rolling window)
// - Policy ROI (model-selected bets)
// - Baseline ROI (all detected bets)
// - Simple ROI (3%+ EV, liquid markets)
// Goal: Policy ROI should be above baseline

// Chart 2: DSR over time (per model version)
// - Show DSR for each deployed model
// - Horizontal line at DSR = 1.0 (threshold for "real signal")
// Goal: DSR should be > 1.0 and stable

// Chart 3: Sample size over time
// - Number of bets placed per day
// - Number of bets settled per day
// Goal: Ensure model isn't over-filtering (coverage > 10%)

// Chart 4: Calibration error over time
// - Expected Calibration Error (ECE)
// - Brier score
// Goal: ECE should be < 0.05 (well-calibrated)
```

**B. Model Version Comparison Table**

```typescript
interface ModelVersionMetrics {
  version: number;
  deployedAt: Date;
  daysLive: number;

  // Training metrics
  trainingAuc: number;
  trainingDsr: number;
  trainingPbo: number;

  // Deployment metrics (computed from settled bets)
  deploymentRoi: number;
  deploymentSharpe: number;
  deploymentSampleSize: number;
  deploymentCoverage: number;

  // Comparison vs baseline
  roiDelta: number; // deployment ROI - baseline ROI
  status: "improving" | "neutral" | "degrading";
}

// Table shows all deployed models sorted by version
// Highlight current model
// Color-code status (green = improving, red = degrading)
```

**C. Cohort Analysis**

```typescript
// Break down model performance by:
// - Market type (1X2, Asian Handicap, Totals, etc.)
// - Odds range (<2.0, 2.0-3.0, 3.0-5.0, >5.0)
// - Competition tier (1, 2, 3)
// - Time to kickoff (<1h, 1-6h, 6-24h, >24h)

interface CohortMetrics {
  cohortName: string;
  sampleSize: number;
  roi: number;
  sharpe: number;
  coverage: number;
  avgMlScore: number;
}

// Goal: Identify which cohorts the model is good/bad at
// Example: "Model is great at Asian Handicap but terrible at 1X2"
```

**Implementation:**

```typescript
// New table: ml_deployment_metrics
// Stores daily aggregated metrics for each model version

export const mlDeploymentMetrics = pgTable("ml_deployment_metrics", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  modelVersion: integer("model_version").notNull(),
  date: date().notNull(),

  // Counts
  betsPlaced: integer("bets_placed").notNull().default(0),
  betsSettled: integer("bets_settled").notNull().default(0),

  // Financial
  totalStake: numeric("total_stake", { precision: 10, scale: 2 }),
  totalPnl: numeric("total_pnl", { precision: 10, scale: 2 }),
  roi: numeric({ precision: 10, scale: 4 }),
  sharpe: numeric({ precision: 10, scale: 4 }),

  // Model metrics
  avgMlScore: numeric("avg_ml_score", { precision: 10, scale: 4 }),
  avgEdgePct: numeric("avg_edge_pct", { precision: 10, scale: 4 }),
  calibrationError: numeric("calibration_error", { precision: 10, scale: 4 }),

  createdAt: timestamp().notNull().defaultNow(),
});

// Background job runs daily to compute metrics
// services/optimizer/app/deployment_tracker.py
```

---

#### 3. Live Scoring Dashboard

**New tab on `/lab/ml`:** "Live Scoring"

**Purpose:** See model predictions in real-time and verify they make sense.

**Components:**

**A. Prediction Distribution**

```typescript
// Histogram of ML scores for all live value bets
// X-axis: ML score (0-1)
// Y-axis: count
// Color: green = placed, gray = not placed

// Goal: Distribution should be spread out (not all 0.5)
// Goal: Placed bets should cluster at high scores
```

**B. Score vs Outcome Scatter**

```typescript
// For settled bets in the last 7 days:
// X-axis: ML score at placement
// Y-axis: actual unit return
// Color: green = won, red = lost

// Add trend line (linear regression)
// Goal: Positive slope (higher score → higher return)
// Goal: R² > 0.05 (model explains some variance)
```

**C. Calibration Plot**

```typescript
// For settled bets in the last 7 days:
// X-axis: predicted P(win) (binned)
// Y-axis: actual win rate
// Diagonal line = perfect calibration

// Goal: Points should be close to diagonal
// Goal: No systematic over/under-prediction
```

**D. Live Bet Feed**

```typescript
// Real-time table of value bets with ML scores
// Columns:
// - Event name
// - Market
// - Soft odds
// - EV%
// - ML score
// - Model edge%
// - Placed? (yes/no)
// - Reason (if not placed)

// Auto-refresh every 5s
// Highlight bets with suspicious scores (e.g., score > 0.9 but EV% < 3%)
```

**Implementation:**

```typescript
// GET /api/ml/live-scoring

export async function GET() {
  const valueBets = getValueBets();
  const last7Days = await db
    .select()
    .from(bets)
    .where(
      and(
        gte(bets.settledAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
        isNotNull(bets.mlScore),
      ),
    );

  // Compute prediction distribution
  const scoreHistogram = computeHistogram(
    valueBets.map((vb) => vb.mlScore).filter((s) => s !== null),
    { bins: 20, min: 0, max: 1 },
  );

  // Compute calibration curve
  const calibration = computeCalibrationCurve(
    last7Days.map((b) => ({ score: b.mlScore!, won: b.outcome === "won" })),
    { bins: 10 },
  );

  // Compute score vs return scatter
  const scatter = last7Days.map((b) => ({
    score: b.mlScore!,
    unitReturn: computeUnitReturn(b.outcome, b.softOdds, b.softCommissionPct),
  }));

  return Response.json({ scoreHistogram, calibration, scatter, valueBets });
}
```

---

#### 4. Feature Importance Tracker

**New tab on `/lab/ml`:** "Feature Importance"

**Purpose:** Understand which features the model is using and track changes over time.

**Components:**

**A. SHAP Waterfall Chart**

```typescript
// For a single bet, show how each feature contributed to the prediction
// X-axis: SHAP value (positive = increases P(win), negative = decreases)
// Y-axis: feature name
// Bars sorted by |SHAP value|

// User can select any bet from the live feed to inspect
```

**B. Feature Importance Trends**

```typescript
// Line chart showing feature importance over model versions
// X-axis: model version
// Y-axis: mean |SHAP value|
// One line per feature (top 10 only)

// Goal: See which features are becoming more/less important
// Example: "movement_pct_sharp importance dropped after v42"
```

**C. Feature Interaction Matrix**

```typescript
// Heatmap showing SHAP interaction values
// Shows which features work together
// Example: "sharp_true_prob and soft_odds have strong interaction"
```

**Implementation:**

```typescript
// Store SHAP values in training_report JSON
// Python trainer already computes this

// GET /api/ml/feature-importance?version=42

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const version = parseInt(searchParams.get("version") || "");

  const model = await db
    .select()
    .from(mlModels)
    .where(eq(mlModels.version, version))
    .limit(1);

  if (!model[0]) {
    return Response.json({ error: "Model not found" }, { status: 404 });
  }

  const report = model[0].trainingReport as any;
  const featureImportance = report.feature_importance || {};

  // Sort by importance
  const sorted = Object.entries(featureImportance)
    .map(([name, value]) => ({ name, value: value as number }))
    .sort((a, b) => b.value - a.value);

  return Response.json({ featureImportance: sorted });
}
```

---

#### 5. Alert System

**Purpose:** Get notified when something goes wrong.

**Alerts to implement:**

```typescript
interface Alert {
  severity: "info" | "warning" | "critical";
  category: "feature" | "model" | "deployment";
  message: string;
  timestamp: Date;
  acknowledged: boolean;
}

// Feature alerts
// - "Feature X has >10% null values" (critical)
// - "Feature X has >80% zero values" (warning)
// - "Feature drift detected: X diverged from training" (warning)

// Model alerts
// - "DSR dropped below 1.0" (critical)
// - "Calibration error >0.10" (warning)
// - "Model hasn't been retrained in 30 days" (info)

// Deployment alerts
// - "Deployment ROI < Baseline ROI for 7 days" (critical)
// - "Model coverage <5% (over-filtering)" (warning)
// - "No bets placed in 24h" (warning)
```

**Implementation:**

```typescript
// Background job checks alerts every hour
// lib/ml/alert-checker.ts

export async function checkAlerts() {
  const alerts: Alert[] = [];

  // Check feature health
  const featureHealth = await fetch("/api/ml/features/health").then((r) =>
    r.json(),
  );
  for (const f of featureHealth.health) {
    if (f.status === "broken") {
      alerts.push({
        severity: "critical",
        category: "feature",
        message: `Feature ${f.featureName} is broken: ${f.issue}`,
        timestamp: new Date(),
        acknowledged: false,
      });
    }
  }

  // Check model performance
  const metrics = await getLatestDeploymentMetrics();
  if (metrics.dsr < 1.0) {
    alerts.push({
      severity: "critical",
      category: "model",
      message: `DSR dropped to ${metrics.dsr.toFixed(2)} (threshold: 1.0)`,
      timestamp: new Date(),
      acknowledged: false,
    });
  }

  // Store alerts in DB
  await db.insert(mlAlerts).values(alerts);

  // Send Telegram notification for critical alerts
  for (const alert of alerts.filter((a) => a.severity === "critical")) {
    await sendTelegramMessage(`🚨 ML Alert: ${alert.message}`);
  }
}
```

---

#### 6. A/B Testing Framework

**Purpose:** Compare old vs new model before full deployment.

**Implementation:**

```typescript
// Add shadow_model_version to bets table
// When a new model is trained, deploy it in "shadow mode"
// Score all bets with both old and new model
// Track which model would have performed better

export const bets = pgTable("bets", {
  // ... existing columns ...

  // Shadow scoring
  shadowModelVersion: integer("shadow_model_version"),
  shadowMlScore: numeric("shadow_ml_score", { precision: 10, scale: 4 }),
  shadowMlStakeFraction: numeric("shadow_ml_stake_fraction", {
    precision: 10,
    scale: 4,
  }),
  shadowWouldPlace: boolean("shadow_would_place"),
});

// After 7 days of shadow scoring, compare:
// - Shadow ROI vs Production ROI
// - Shadow Sharpe vs Production Sharpe
// - Shadow coverage vs Production coverage

// If shadow model is better, promote to production
// If shadow model is worse, discard and investigate
```

**UI Component:**

```typescript
// New tab on `/lab/ml`: "A/B Test"

interface ABTestResult {
  shadowVersion: number;
  productionVersion: number;
  daysRunning: number;

  shadowMetrics: {
    roi: number;
    sharpe: number;
    sampleSize: number;
    coverage: number;
  };

  productionMetrics: {
    roi: number;
    sharpe: number;
    sampleSize: number;
    coverage: number;
  };

  winner: "shadow" | "production" | "tie";
  confidence: number; // p-value from t-test
}

// Show side-by-side comparison
// Button to promote shadow model if it's winning
```

---

### Summary: UI Changes Needed

**New pages:**

1. `/lab/ml/features` — Feature health dashboard
2. `/lab/ml/performance` — Performance history tracker
3. `/lab/ml/live` — Live scoring dashboard
4. `/lab/ml/importance` — Feature importance tracker
5. `/lab/ml/alerts` — Alert management
6. `/lab/ml/ab-test` — A/B testing dashboard

**New API endpoints:**

1. `GET /api/ml/features/health` — Feature distribution stats
2. `GET /api/ml/features/drift` — Feature drift detection
3. `GET /api/ml/performance/history` — Time-series metrics
4. `GET /api/ml/performance/cohorts` — Cohort analysis
5. `GET /api/ml/live-scoring` — Real-time predictions
6. `GET /api/ml/feature-importance` — SHAP values
7. `GET /api/ml/alerts` — Active alerts
8. `GET /api/ml/ab-test` — A/B test results

**New database tables:**

1. `ml_deployment_metrics` — Daily aggregated metrics per model
2. `ml_alerts` — Alert history
3. `ml_feature_snapshots` — Feature distributions over time (for drift detection)

**Existing page updates:**

1. `/lab/ml` — Add new tabs for monitoring
2. `/value-bets` — Show ML score in spreadsheet (already exists?)
3. `/bets` — Show ML score and shadow score in history

---

## Next Steps

1. **Audit current model performance** — check training AUC, deployment ROI, DSR
2. **Implement Phase 1-5** — fix leakage, weighting, policy threshold
3. **Implement Phase 6** — build monitoring dashboard
4. **Retrain and compare** — old model vs new model on same holdout set
5. **Deploy in shadow mode** — run A/B test for 7 days
6. **Promote if better** — otherwise, iterate on features/architecture

Let me know your current metrics and I can help diagnose further.
