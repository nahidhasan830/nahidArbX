# ML Optimizer Pipeline — 5-Step Implementation Plan

> Each step is self-contained. An agent can execute any step given only this document + the codebase.

## System Context (Read First)

**What this system does**: Real-time value betting platform. Pinnacle (sharp bookmaker) odds define "true probability" via vig removal. Soft bookmakers (NineWickets, Velki) sometimes offer odds above true probability = positive expected value. The reactive detector fires every 500ms on odds changes, identifies value bets, persists to Postgres, and auto-places bets.

**Architecture**: Dual-process — `engine.ts` (background) + Next.js (web-only UI). Next.js API routes proxy to engine HTTP API (port 3001) via `lib/engine-proxy.ts` for any data in engine memory. Dev workflow: `npm run engine` → `npm run dev` (or `npm run dev:all`).

**Key files**:
- `engine.ts` — Standalone engine entry point (all 13 background subsystems + ML scoring)
- `instrumentation.ts` — Next.js boot (DB pool init + frontend Telegram ping only — **no background work**)
- `lib/shared/engine-http.ts` — Engine HTTP API server (exposes in-memory state to Next.js)
- `lib/engine-proxy.ts` — Next.js proxy client (`engineGet`/`enginePost`) for engine HTTP API
- `lib/atoms/store.ts` — 4D in-memory odds store: event→family→atom→provider→{odds,timestamp}
- `lib/atoms/odds-history.ts` — Ring buffer (200 ticks/atom/provider) with steam detection, sparklines
- `lib/atoms/value-detector.ts` — EV calculation, `ValueBet` type, vig removal via worst-case composite
- `lib/background/reactive-detector.ts` — 500ms debounced detection pass, persistence, auto-place (engine-only)
- `lib/betting/auto-placer.ts` — Strategy gate → `placeBetForValueBet()` (engine-only)
- `lib/db/schema.ts` — Drizzle schema (Postgres, snake_case casing)
- `lib/shared/constants.ts` — All magic numbers
- `lib/optimizer/` — **LEGACY** optimizer (16 files, to be replaced)
- `services/optimizer/` — **LEGACY** Python sidecar (CPCV parameter sweeps)

**Rules from AGENTS.md**:
- `singleton()` for HMR-safe state, never module-level `let`
- `npm run build && npm run lint` after every change
- Drizzle casing: DB snake_case, TS camelCase
- Tailwind only for UI — no custom CSS
- `lib/shared/constants.ts` for magic numbers
- Every tooltip uses `<Tooltip>`/`<TooltipTrigger>`/`<TooltipContent>` — never plain `title=""`
- Explanatory copy: plain English headline + body with concrete betting example. No jargon.

---

## Step 1 — Schema + Feature Engineering

**Goal**: Add ML columns to `bets` table, create `ml_models` table, build the 23-dim feature extractor and convergence calculator.

### 1A. Schema Migration

Edit `lib/db/schema.ts`. Add 3 columns to the `bets` table (after the `oddsMovement` field, before the closing `}`):

```typescript
// ML pipeline columns
mlFeatures: real("ml_features").array(),         // 23-dim feature vector (real[] for speed and preventing JSONB tuple bloat during HOT updates)
mlScore: real(),                                 // P(profitable) from LightGBM [0,1]  
mlKellyAdjusted: real(),                         // Dynamic Kelly multiplier from staker
```

Add new `mlModels` table after the `bettingSettings` table:

```typescript
export const mlModels = pgTable("ml_models", {
  id: text().primaryKey(),
  version: integer().notNull(),
  status: text().notNull().default("training"), // training|validated|deployed|retired
  modelType: text().notNull().default("lightgbm"),
  trainingSamples: integer().notNull(),
  featureCount: integer().notNull().default(23),
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
  trainingReport: jsonb(),
  deployedAt: ts(),
  retiredAt: ts(),
  createdAt: tsNow(),
}, (t) => [
  index("ml_models_status_idx").on(t.status),
  index("ml_models_deployed_idx").on(t.deployedAt.desc())
    .where(sql`${t.status} = 'deployed'`),
]);
```

Add `mlMinScore` to `bettingSettings` table (after `activeStrategyIds`):

```typescript
mlMinScore: numeric({ precision: 4, scale: 2, mode: "number" }).notNull().default(0.4),
```

Run: `npm run db:generate && npm run db:migrate`

### 1B. Feature Extractor — `lib/ml/features.ts`

Create `lib/ml/features.ts`. This extracts 23 features from in-memory stores for a `ValueBet`.

**Imports needed**:
- `ValueBet` from `lib/atoms/value-detector`
- `getAtomHistory`, `getOrderedTicks`, `detectSteamMove`, `getMovementSummary` from `lib/atoms/odds-history`
- `getAllOddsForAtom` from `lib/atoms/store`
- `getFamily` from `lib/atoms/registry`
- `getCachedVigData` from `lib/atoms/value-detector`
- `getProviderCommission` from `lib/providers/registry`
- `getEvent` from `lib/store`
- `computeConvergenceRate` from `lib/ml/convergence`
- `differenceInMinutes` from `date-fns`

**Feature list** (indices 0–22, order matters — must match Python training):

All history/store functions require the full key `(vb.eventId, vb.familyId, vb.atomId, provider)`. Shorthand below uses `eId = vb.eventId, fId = vb.familyId, aId = vb.atomId`.

| Idx | Name | Source |
|--:|------|--------|
| 0 | ev_pct | `vb.evPct` |
| 1 | sharp_true_prob | `vb.trueProb` |
| 2 | soft_odds | `vb.softOdds` |
| 3 | adjusted_soft_odds | `vb.adjustedSoftOdds` |
| 4 | implied_prob_gap | `vb.trueProb - 1/vb.softOdds` |
| 5 | soft_odds_age_ms | `Date.now() - vb.timestamp` |
| 6 | tick_count | `getAtomHistory(eId, fId, aId, vb.softProvider)?.totalTicks ?? 0` |
| 7 | time_to_kickoff_min | `differenceInMinutes(getEvent(eId)!.startTime, new Date())` — `startTime` is a `Date` object |
| 8 | movement_pct_sharp | `getMovementSummary(eId, fId, aId, vb.sharpProvider)?.changePct ?? 0` |
| 9 | movement_pct_soft | `getMovementSummary(eId, fId, aId, vb.softProvider)?.changePct ?? 0` |
| 10 | steam_move_sharp | `detectSteamMove(eId, fId, aId, vb.sharpProvider) != null ? 1 : 0` — 1 if Pinnacle odds moved ≥3% in last 60s |
| 11 | steam_move_soft | `detectSteamMove(eId, fId, aId, vb.softProvider) != null ? 1 : 0` |
| 12 | sharp_direction | `getMovementSummary(eId, fId, aId, vb.sharpProvider)?.direction` → `up=1, down=-1, stable=0` |
| 13 | soft_direction | `getMovementSummary(eId, fId, aId, vb.softProvider)?.direction` → same encoding |
| 14 | convergence_rate | `computeConvergenceRate(eId, fId, aId, vb.sharpProvider, vb.softProvider)` |
| 15 | tick_velocity | `getOrderedTicks(eId, fId, aId, vb.softProvider)` → `totalTicks / (last.timestamp - first.timestamp) * 60_000` |
| 16 | provider_count | `getAllOddsForAtom(eId, fId, aId).size` |
| 17 | opening_sharp_odds | `getAtomHistory(eId, fId, aId, vb.sharpProvider)?.openingOdds ?? 0` |
| 18 | market_type_encoded | `getFamily(fId)?.market_type` → ordinal: MATCH_RESULT=0, TOTAL_GOALS=1, ASIAN_HANDICAP=2, etc. |
| 19 | is_asian_line | `getFamily(fId)` → `f.line != null && (f.line * 4) % 1 === 0 && f.line % 0.5 !== 0 ? 1 : 0` |
| 20 | commission_pct | `getProviderCommission(vb.softProvider)` |
| 21 | kelly_fraction_raw | `vb.kellyFraction` |
| 22 | vig_pct | `getCachedVigData(vb.eventId, vb.familyId)?.vigPct ?? 0` |

Export: `function extractFeatures(vb: ValueBet): number[]` — returns 23-element array. Nulls/undefined default to 0. All values rounded to 4 decimal places to prevent HOT-busting float drift on re-persist.

Also export: `const FEATURE_NAMES: string[]` — parallel array of names for interpretability.

Also export: `const FEATURE_COUNT = 23` — single source of truth for dimensionality.

### 1C. Convergence Calculator — `lib/ml/convergence.ts`

Create `lib/ml/convergence.ts`. Single export:

```typescript
export function computeConvergenceRate(
  eventId: string, familyId: string, atomId: string,
  sharpProvider: string, softProvider: string,
  windowTicks = 20
): number
```

Algorithm:
1. `const sharpTicks = getOrderedTicks(eventId, familyId, atomId, sharpProvider)`
2. `const softTicks = getOrderedTicks(eventId, familyId, atomId, softProvider)`
3. Take last `windowTicks` from each
4. For each soft tick, **interpolate** the sharp odds at `softTick.timestamp`:
   - Find surrounding sharp ticks `[before, after]` where `before.ts ≤ softTick.ts ≤ after.ts`
   - If both exist: linear interpolation `sharpOdds = before.odds + (after.odds - before.odds) * (softTs - beforeTs) / (afterTs - beforeTs)`
   - If only `before` exists and age < 5s: use `before.odds` (flat extrapolation)
   - Otherwise: skip this soft tick (no aligned pair)
5. Compute gap series: `softOdds[i] - interpolatedSharpOdds[i]` for aligned pairs
6. If <3 aligned pairs, return 0
7. Normalize timestamps: `x = (tick.timestamp - firstTick.timestamp) / 1000`
8. Linear regression slope (OLS: `slope = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)`)
9. Negative slope = converging (soft moving toward sharp), positive = diverging

### 1D. Constants

Add to `lib/shared/constants.ts`:

```typescript
// ML pipeline
export const ML_MIN_SCORE = 0.4;           // Below this, don't auto-place
export const ML_COLD_START_THRESHOLD = 500; // Need this many settled bets for ML
export const ML_FEATURE_COUNT = 23;        // Dimensionality of feature vector
```

### 1E. Verify

```bash
npm run build && npm run lint
```

Write unit tests in `lib/ml/__tests__/features.test.ts` using Node test runner (`node --import tsx --test`). Test with synthetic `ValueBet` objects, verify output is 23-element number array with expected values.

---

## Step 2 — Reactive Detector Integration (Feature Persistence)

**Goal**: Wire feature extraction into the detection pass. After value detection, compute features for each changed bet and persist them in the `ml_features` column. No scoring yet.

### 2A. Modify `lib/background/reactive-detector.ts`

**Import** `extractFeatures` from `lib/ml/features`.

In `runDetectionPass()`, after the `changedBets` filter (line ~168), before enriching with movement snapshots:

1. Compute features for each changed bet:
```typescript
const featuresMap = new Map<string, number[]>();
const featureStart = Date.now();
for (const vb of changedBets) {
  try {
    featuresMap.set(vb.id, extractFeatures(vb));
  } catch {
    // Feature extraction failure must never block detection
  }
}
const featureMs = Date.now() - featureStart;
if (featureMs > 10) logger.warn("ReactiveDetector", `Feature extraction slow: ${featureMs}ms`);
```

2. When building `enrichedBets` (line ~172), add the features:
```typescript
return {
  ...vb,
  oddsMovement: ...,
  mlFeatures: featuresMap.get(vb.id) ?? null,
};
```

### 2B. Modify `lib/db/repositories/bets.ts`

Update `persistValueBets` function signature to accept optional `mlFeatures`:

In the input type (line ~48), add:
```typescript
mlFeatures?: number[] | null;
```

In the `payload` object (line ~105), add:
```typescript
mlFeatures: vb.mlFeatures ?? null,
```

In the `onConflictDoUpdate.set` (line ~148), add:
```typescript
mlFeatures: vb.mlFeatures ?? sql`${bets.mlFeatures}`,
```

### 2C. Verify

```bash
npm run build && npm run lint
```

Start the engine (`npm run engine` or `npm run dev:all`), wait for odds to flow, then check DB:
```sql
SELECT id, ml_features FROM bets WHERE ml_features IS NOT NULL LIMIT 5;
```

Verify `ml_features` is a 23-element array. Check reactive detector logs (engine process output) for feature extraction timing — should be <5ms.

---

## Step 3 — Python Training Sidecar (LightGBM + ONNX)

**Goal**: Replace the old `services/optimizer/` Python sidecar with a LightGBM training pipeline that reads features from `bets` table, trains via CPCV, exports ONNX model to GCS.

### 3A. Restructure `services/optimizer/`

Keep the infrastructure files (`Dockerfile`, `pyproject.toml`, `redeploy.sh`). Replace `app/` contents.

Update `pyproject.toml` dependencies — replace `optuna` and `xgboost` with:
```
"lightgbm>=4.5.0",
"onnx>=1.17.0",
"onnxmltools>=1.12.0",
"skl2onnx>=1.17.0",
"scikit-learn>=1.5.0",
"shap>=0.46.0",
```

Keep: `sqlalchemy`, `cloud-sql-python-connector`, `numpy`, `scipy`, `pandas`, `polars`, `pyarrow`.

### 3B. New Python modules

**`app/loader.py`** — Load training data:
```sql
SELECT id, ml_features, outcome, pnl,
       soft_odds, sharp_true_prob, soft_commission_pct,
       closing_sharp_odds,
       first_seen_at, event_start_time
FROM bets
WHERE outcome <> 'pending' AND ml_features IS NOT NULL
ORDER BY first_seen_at
```

Derive `clv_pct` in Python (not a DB column):
```python
# CLV% = (closing_fair_odds / detection_fair_odds - 1) * 100
df['clv_pct'] = np.where(
    df['closing_sharp_odds'].notna() & (df['closing_sharp_odds'] > 0),
    ((1 / df['sharp_true_prob']) / df['closing_sharp_odds'] - 1) * 100,
    np.nan
)
```

Convert `outcome` to binary label: `won`/`half_won` → 1, else → 0. Features from `ml_features` array → numpy array.

**`app/cpcv.py`** — Combinatorial Purged Cross-Validation:
- 10 temporal groups (sorted by `first_seen_at`), pick 2 for test → 45 paths
- Purge: remove training bets from same event as any test bet
- 1% embargo: exclude training bets within 1% of temporal boundary
- Return list of (train_indices, test_indices) tuples

**`app/trainer.py`** — LightGBM training:
- For each CPCV fold: train LightGBM binary classifier, predict OOS
- Aggregate OOS predictions across all folds
- Compute metrics: ROI, AUC-ROC, log-loss, calibration error
- Compute Deflated Sharpe Ratio (DSR) and Probability of Backtest Overfitting (PBO)
- If DSR > 0.8 AND PBO < 0.5: export model as ONNX
- Compute SHAP feature importance

**`app/exporter.py`** — ONNX export + GCS upload:
- Convert LightGBM model to ONNX via `onnxmltools`
- **Embed feature names in ONNX model metadata**: `model.metadata_props.append(StringStringEntry(key="feature_names", value=",".join(FEATURE_NAMES)))`
- Upload to GCS bucket (same bucket as entity-matcher models)
- Write row to `ml_models` table with all metrics

**`app/job.py`** — Entry point (Cloud Run Job):
```python
def main():
    data = loader.load_training_data()
    if len(data) < ML_COLD_START_THRESHOLD:
        print(f"Only {len(data)} samples, need {ML_COLD_START_THRESHOLD}. Skipping.")
        return
    splits = cpcv.generate_splits(data)
    model, metrics = trainer.train(data, splits)
    if metrics.dsr > 0.8 and metrics.pbo < 0.5:
        exporter.export_and_upload(model, metrics)
    else:
        print(f"Model rejected: DSR={metrics.dsr:.3f}, PBO={metrics.pbo:.3f}")
```

### 3C. Feature Name Contract

Create `app/feature_names.py` with the exact 23 feature names in the same order as `lib/ml/features.ts:FEATURE_NAMES`. This is the contract between Node.js and Python — if order changes, both must update.

**Runtime validation** (in Node.js scorer at model load time):
```typescript
const modelFeatureNames = session.metadata?.feature_names;
if (modelFeatureNames && modelFeatureNames !== FEATURE_NAMES.join(',')) {
  throw new Error(`Feature name mismatch! Model expects [${modelFeatureNames}] but code has [${FEATURE_NAMES.join(',')}]`);
}
```
This fails loud at model load instead of silently producing garbage predictions.

### 3D. Verify

```bash
cd services/optimizer && uv sync && uv run pytest
```

Test with synthetic data: seed 1,000+ rows of dummy data into a temporary table to validate the full pipeline (from Python trainer to ONNX model generation). After the test completes and metrics are verified in `ml_models`, drop the temporary table.

---

## Step 4 — ONNX Scorer + Dynamic Kelly + Auto-Placer ML Gate

**Goal**: Load trained ONNX model in Node.js, score bets in real-time, apply dynamic Kelly sizing, replace strategy gate with ML gate.

### 4A. Install onnxruntime-node

```bash
npm install onnxruntime-node
```

No `next.config.ts` changes needed — the ONNX scorer runs exclusively in the engine process (plain Node.js, no webpack). Next.js never imports `onnxruntime-node`.

### 4B. Create `lib/ml/scorer.ts`

Uses `singleton()` pattern for HMR safety. Lazy model loading (NOT at boot).

```typescript
import { singleton } from "@/lib/util/singleton";
import { logger } from "@/lib/shared/logger";
import { FEATURE_NAMES } from "./features";

const state = singleton("ml:scorer", () => ({
  session: null as import("onnxruntime-node").InferenceSession | null,
  loadAttempted: false,
}));

export async function ensureModel(): Promise<boolean> {
  if (state.loadAttempted) return state.session != null;
  state.loadAttempted = true;
  try {
    const ort = await import("onnxruntime-node");
    // Try local cache first, then GCS download
    state.session = await ort.InferenceSession.create(modelPath);
    // Validate feature name contract
    const modelFeatureNames = state.session.metadata?.feature_names;
    if (modelFeatureNames && modelFeatureNames !== FEATURE_NAMES.join(',')) {
      throw new Error(`Feature name mismatch! Model: [${modelFeatureNames}], Code: [${FEATURE_NAMES.join(',')}]`);
    }
    logger.info("MLScorer", "Model loaded successfully");
    return true;
  } catch (err) {
    logger.warn("MLScorer", `Model load failed, using rule-based fallback: ${err}`);
    return false;
  }
}

export async function scoreBatch(featureArrays: number[][]): Promise<number[]> {
  if (!state.session) return featureArrays.map(() => 1.0); // pass-through
  const ort = await import("onnxruntime-node");
  const flat = new Float32Array(featureArrays.flat());
  const tensor = new ort.Tensor("float32", flat, [featureArrays.length, 23]);
  const results = await state.session.run({ input: tensor });
  // LightGBM ONNX outputs probabilities as [n, 2] — column 1 is P(positive)
  const probs = results.probabilities?.data as Float32Array;
  return Array.from({ length: featureArrays.length }, (_, i) => probs[i * 2 + 1]);
}
```

Add model version watching: query `ml_models WHERE status='deployed'` every 60 seconds, reload if version changes.

Call `ensureModel()` eagerly in `engine.ts` (after `startReactiveDetector()`, ~line 143) to front-load the 50-200ms ONNX session warmup. First detection pass would otherwise eat that latency:

```typescript
// engine.ts — after startReactiveDetector()
import("./lib/ml/scorer").then(({ ensureModel }) => ensureModel()).catch(() => {});
logger.info("Boot", "ML model warmup initiated (non-blocking)");
```

Do **NOT** touch `instrumentation.ts` — it is UI-only (DB pool + Telegram boot ping).

> [!WARNING]
> **Process isolation**: `lib/ml/scorer.ts` is strictly engine-only. It must never be imported by Next.js API routes or React Server Components — the `onnxruntime-node` native binaries would crash webpack. The dual-process architecture guarantees this isolation by process boundary: scoring happens in `engine.ts`, Next.js reads scores from the `bets` table or via `engineGet()` proxy.

### 4C. Create `lib/ml/staker.ts`

Dynamic Kelly sizing based on ML score and features:

```typescript
import { FEATURE_NAMES } from "./features";
import { ML_MIN_SCORE } from "@/lib/shared/constants";

// Compile-time index map — O(1) lookup, fails loud on typo (undefined access)
const F = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i])
) as Record<string, number>;

export function computeAdjustedKelly(
  baseKelly: number,
  mlScore: number,
  features: number[],
): number {
  if (mlScore < ML_MIN_SCORE) return 0; // Skip
  
  let multiplier = 1.0;
  
  // Score-based scaling (linear interpolation 0.4→1.0 maps to 0.5→1.5)
  multiplier *= 0.5 + (mlScore - 0.4) * (1.0 / 0.6);
  
  // Convergence penalty (smooth continuous function instead of erratic hard cutoff)
  const convergence = features[F.convergence_rate];
  if (convergence < 0) {
    multiplier *= Math.max(0.5, 1 + convergence); 
  }
  
  // Persistence bonus
  if (features[F.tick_count] > 10) multiplier *= 1.2;
  
  // Steam confirmation
  if (features[F.steam_move_sharp] > 0) multiplier *= 1.3;
  
  // Cap at full Kelly
  return Math.min(baseKelly * multiplier, baseKelly * 2);
}
```

### 4D. Wire into Reactive Detector

In `reactive-detector.ts`, after feature extraction (added in Step 2):

1. Batch-score: `const scores = await scoreBatch(featureArrays)`
2. Compute adjusted Kelly: `computeAdjustedKelly(vb.kellyFraction, score, features)`
3. **Persist ALL bets** with `mlScore` and `mlKellyAdjusted` alongside `mlFeatures` — do NOT filter before persistence. Low-score bets are still valuable training data for the next model iteration.
4. Filtering happens downstream at the **auto-placer gate only** (§4E)

Update `persistValueBets` input type to include `mlScore` and `mlKellyAdjusted`.

### 4E. Replace Auto-Placer Gate

In `lib/betting/auto-placer.ts`:

Replace the active-strategy gate (lines 52–70) with ML score gate:

```typescript
// ML confidence gate (replaces legacy strategy gate)
const { row: settings } = await getBettingSettings();
if (vb.mlScore != null && vb.mlScore < (settings.mlMinScore ?? 0.4)) {
  logger.info("AutoPlacer", `[${vb.softProvider}] ${stableId} → skipped: ML score ${vb.mlScore.toFixed(2)}`);
  return;
}
```

For Kelly stake, prefer ML-adjusted when available:
```typescript
kellyStake: vb.mlKellyAdjusted ?? vb.kellyStake,
```

Remove imports of `getActiveStrategies` and `findMatchingActiveStrategy`.

### 4F. Verify

```bash
npm run build && npm run lint
```

Start the engine (`npm run engine`) — all ML scoring runs in this process:

- Without a model: verify system behaves identically (scorer returns 1.0, no filtering)
- With a test model: verify `ml_score` column is populated, auto-placer respects threshold
- Check detection pass latency in engine logs (should be <5ms total)
- Verify Next.js (`npm run dev`) can read ML scores from the `bets` table — no engine proxy needed for persisted scores

---

## Step 5 — Legacy Cleanup + Model Status UI + Retraining Scheduler

**Goal**: Remove old optimizer code, build a guided ML model status UI with tooltips for complex metrics, drop legacy DB tables.

### 5A. Remove `lib/optimizer/` files

Delete these files entirely:
- `strategies.ts`, `strategy-filters.ts`, `strategy-filter-sql.ts`
- `apply-strategy-to-prefs.ts`, `active-strategies.ts`, `use-live-strategies.ts`
- `live-metrics-aggregator.ts`, `repository.ts`, `schedules.ts`
- `trial-quality.ts`, `types.ts`, `format-strategy.ts`
- `api-client.ts`, `schedule-types.ts`

**Keep and repurpose** (these run in the engine process via `engine.ts`):
- `scheduler.ts` → strip to just: poll `ml_models` for retraining triggers, fire Cloud Run Job
- `notifier-tick.ts` → strip to: notify on model training completion

### 5B. Update all importers

Search: `from "@/lib/optimizer` — ~38 files reference the old optimizer.

**Backend — engine process** (update imports, remove dead code):
- `engine.ts` — update `startOptimizerScheduler` → `startModelRetrainingScheduler` (lines 49, 113-119); update shutdown handler (line 223: `stopOptimizerScheduler` → `stopModelRetrainingScheduler`)
- `lib/betting/auto-placer.ts` — already updated in Step 4
- `lib/telegram/commands/optimiser-commands.ts` — replace with ML model status commands
- `lib/telegram/commands/control-commands.ts` — remove `invalidateActiveStrategiesCache`
- `lib/telegram/commands/destructive-commands.ts` — replace optimizer commands with model retrain
- `lib/telegram/commands/settings-commands.ts` — remove strategy cache invalidation

> [!IMPORTANT]
> `instrumentation.ts` has **no optimizer imports** — it was already cleaned up during the backend separation. Do not modify it.

**Engine HTTP API** — add ML status endpoint to `lib/shared/engine-http.ts`:
- `GET /engine/ml/status` — returns model load status, version, feature count, inference stats (avg latency, total scored), scorer health
- This lets the Next.js UI show live ML scoring status via `engineGet("/engine/ml/status")`

**Frontend** (remove old UI, add ML model status):
- `components/optimizer/StrategyPickerPill.tsx` — delete
- `components/spreadsheet/ValueBetSpreadsheet.tsx` — remove strategy picker imports
- `components/dashboard/BettingStrategyCard.tsx` — replace with ML model status card
- `components/bets-history/BetsHistorySpreadsheet.tsx` — remove strategy imports
- `components/lab/optimisation/*.tsx` (12 files) — delete all, create minimal `MLModelStatus.tsx`
- `app/api/optimizer/**` routes — delete all, replace with:
  - `app/api/ml/models/route.ts` — direct DB query for `ml_models` table (training history, metrics)
  - `app/api/ml/status/route.ts` — proxies to `engineGet("/engine/ml/status")` for live scorer state
  - `app/api/ml/retrain/route.ts` — triggers Cloud Run Job directly via GCP Admin API (no engine proxy needed — just an API call)

### 5C. ML Model Status UI — `MLModelStatus.tsx`

Replace the old optimisation lab tab with a **guided, beginner-friendly** ML model status page. Design principles:
- Plain English headlines with concrete betting examples
- Every metric gets a `<Tooltip>` explaining what it means in betting context
- No jargon without explanation
- Progressive disclosure: summary first, details on expand

**Key UI elements:**

1. **Model Health Card** — top-level status badge (training/deployed/no model)
   - Show `mlMinScore` slider with tooltip: "Bets scoring below this threshold won't be auto-placed. Higher = more selective, fewer bets. Lower = more bets, but riskier."

2. **Performance Metrics Table** — for the deployed model, show:
   - AUC-ROC with `<TooltipContent>`: "Area Under ROC Curve. Measures how well the model separates winning bets from losing ones. 0.5 = coin flip, 1.0 = perfect prediction. Above 0.6 is useful for betting."
   - Deflated Sharpe with `<TooltipContent>`: "Risk-adjusted return after accounting for the fact that we tried many models. A DSR above 0.8 means the model's edge is likely real, not luck from over-testing."
   - PBO with `<TooltipContent>`: "Probability of Backtest Overfitting. Chance that the best model in training would actually be the WORST in live betting. Below 0.5 means we're probably not overfit."
   - Calibration Error with `<TooltipContent>`: "How closely the model's predicted probabilities match reality. E.g., when the model says '70% chance of winning', do those bets actually win ~70% of the time? Lower = better calibrated."
   - Log Loss with `<TooltipContent>`: "Measures prediction confidence accuracy. Heavily penalises confident wrong predictions. Lower is better."

3. **Feature Importance Chart** — horizontal bar chart from SHAP values
   - Each feature label gets a tooltip explaining what it measures in plain English
   - E.g., `convergence_rate` tooltip: "Are the soft bookmaker's odds moving toward Pinnacle's price? Negative = converging (value window closing), Positive = diverging (edge growing)."

4. **Training History Table** — `<DataTable>` showing `ml_models` rows
   - Columns: version, status, samples, DSR, PBO, AUC, deployed date
   - Each column header gets a tooltip

5. **Retrain Button** — fires Cloud Run Job manually
   - Shows estimated training time and cost
   - Confirmation dialog with tooltip: "This will train a new model on all settled bets with ML features. Takes ~5-15 minutes. The current model continues serving until the new one passes quality gates."

### 5D. Schema: Drop legacy tables

After all code references are removed, edit `lib/db/schema.ts`:
- Delete `optimizationRuns` table definition + types
- Delete `optimizationTrials` table definition + types
- Delete `optimizationStrategies` table definition + types
- Delete `optimizationSchedules` table definition + types

Run: `npm run db:generate && npm run db:migrate`

This produces a migration that drops the 4 tables.

### 5E. Update architecture doc

Update `docs/reactive-odds-engine-architecture.md`:
- Add §15 "ML Scoring Pipeline" documenting:
  - ONNX scorer loads in `engine.ts` (not Next.js) — process-isolated from webpack
  - Feature extraction + scoring runs inline in the detection pass (engine process only)
  - Next.js reads ML data via engine proxy (`/engine/ml/status`) or direct DB queries (`ml_models`, `bets.ml_score`)
- Update §5 (Reactive Detector) to mention feature extraction + ONNX scoring
- Update §6 (Value Detection Math) to mention ML confidence gate
- Update §10 (Boot Sequence) to include ML model warmup step after ReactiveDetector start
- Update §14 (Decommissioned) to list the old optimizer tables

### 5F. Verify

```bash
npm run build && npm run lint
```

- Verify no remaining imports of deleted files
- Start engine (`npm run engine`) — verify ML scorer initialises, detection pipeline works end-to-end
- Start Next.js (`npm run dev`) — verify UI loads cleanly, ML status API returns data via engine proxy
- Or use `npm run dev:all` to test both processes together

---

## Quick Reference: What Changes Where

| File | Step | Action |
|------|:----:|--------|
| `lib/db/schema.ts` | 1, 5 | Add ml columns + ml_models table; later drop optimizer tables |
| `lib/ml/features.ts` | 1 | NEW — 23-dim feature extractor |
| `lib/ml/convergence.ts` | 1 | NEW — sharp-soft convergence rate (interpolation-based) |
| `lib/ml/scorer.ts` | 4 | NEW — ONNX inference singleton with feature name validation (engine-only) |
| `lib/ml/staker.ts` | 4 | NEW — dynamic Kelly sizing with compile-time index map |
| `lib/shared/constants.ts` | 1 | Add ML constants |
| `engine.ts` | 4, 5 | Call `ensureModel()` for boot warmup; update optimizer→ML scheduler |
| `lib/shared/engine-http.ts` | 5 | Add `GET /engine/ml/status` endpoint for live scorer state |
| `lib/background/reactive-detector.ts` | 2, 4 | Wire features, then scoring (engine process only) |
| `lib/db/repositories/bets.ts` | 2, 4 | Accept ml_features, then ml_score |
| `lib/betting/auto-placer.ts` | 4 | Replace strategy gate with ML gate (engine process only) |
| `services/optimizer/` | 3 | Rebuild Python sidecar for LightGBM |
| `lib/optimizer/` (16 files) | 5 | Delete most, repurpose scheduler |
| `components/lab/optimisation/` (12 files) | 5 | Delete, replace with guided `MLModelStatus.tsx` |
| `app/api/optimizer/` (8 routes) | 5 | Delete, replace with `app/api/ml/{models,status,retrain}` |
