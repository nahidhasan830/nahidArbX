# ML Optimizer — Complete Guide

## What Does the Optimizer Do?

In simple words: **the optimizer learns which value bets actually win and which ones lose, then uses that knowledge to filter and size future bets automatically.**

Without the optimizer, every bet that passes the EV% threshold gets placed with a fixed stake. With the optimizer, a trained ML model scores each bet with a **P(profitable)** confidence score from 0 to 1:

| Score     | Meaning                                       | What Happens                                  |
| --------- | --------------------------------------------- | --------------------------------------------- |
| **0.9**   | "This bet looks very similar to past winners" | Placed with **larger** stake (up to 2× Kelly) |
| **0.6**   | "Decent chance, but some red flags"           | Placed with **normal** stake                  |
| **< 0.4** | "This looks like past losers"                 | **Skipped entirely** — not placed             |

---

## The Big Picture — How Everything Connects

```mermaid
graph TB
    subgraph ENGINE["🖥 Engine Process (engine.ts)"]
        direction TB
        SCRAPER["📡 Scrapers<br/>(Pinnacle, NineWickets, etc.)"]
        DETECTOR["🔍 Reactive Detector<br/>(finds value bets)"]
        FEATURES["📊 Feature Extractor<br/>(25 dimensions)"]
        SCORER["🤖 ONNX Scorer<br/>(P(profitable))"]
        STAKER["💰 Kelly Staker<br/>(adjusted stake size)"]
        PLACER["🎯 Auto-Placer<br/>(places on bookmaker)"]
    end

    subgraph DB["🗄 Postgres Database"]
        BETS["bets table<br/>(ml_features, ml_score,<br/>outcome, pnl)"]
        MODELS["ml_models table<br/>(version, metrics,<br/>ONNX artifact blob)"]
    end

    subgraph OPTIMIZER["🐍 Python Optimizer Service"]
        LOADER["📥 Loader<br/>(load ml_training_examples)"]
        TRAINER["🏋️ Trainer<br/>(LightGBM + CPCV)"]
        EXPORTER["📦 Exporter<br/>(ONNX + GCS)"]
    end

    subgraph GCS["☁️ Google Cloud Storage"]
        ONNX_FILE["model.onnx<br/>(~8 KB)"]
    end

    SCRAPER -->|"live odds"| DETECTOR
    DETECTOR -->|"value bets"| FEATURES
    FEATURES -->|"25-dim vector"| SCORER
    SCORER -->|"P(profitable)"| STAKER
    STAKER -->|"adjusted Kelly"| PLACER
    DETECTOR -->|"persist with<br/>ml_features + ml_score"| BETS
    BETS -->|"settled bets<br/>with outcomes"| LOADER
    LOADER -->|"labelled training data"| TRAINER
    TRAINER -->|"trained model"| EXPORTER
    EXPORTER -->|"upload"| ONNX_FILE
    EXPORTER -->|"write model row"| MODELS
    ONNX_FILE -->|"download on boot"| SCORER
    MODELS -->|"version polling<br/>(every 60s)"| SCORER

    style ENGINE fill:#1e293b,stroke:#3b82f6,color:#e2e8f0
    style DB fill:#1e293b,stroke:#22c55e,color:#e2e8f0
    style OPTIMIZER fill:#1e293b,stroke:#f59e0b,color:#e2e8f0
    style GCS fill:#1e293b,stroke:#8b5cf6,color:#e2e8f0
```

---

## Part 1: How Data is Collected (Automatic)

Every time the engine detects a value bet, it **automatically** computes and stores a 25-dimension feature vector alongside the bet. You don't need to do anything — this happens on every detection pass (~500ms after any odds change).

```mermaid
sequenceDiagram
    participant S as Scrapers
    participant D as Reactive Detector
    participant F as Feature Extractor
    participant DB as Postgres (bets table)

    S->>D: New odds arrived (dirty families)
    D->>D: detectAllValueBetsIncremental()
    D->>F: extractFeatures(valueBet)
    F-->>D: [5.56, 0.285, 3.70, ..., 6.54] (25 numbers)
    D->>DB: INSERT/UPDATE bets SET ml_features = [...]
    Note over DB: Feature vector is stored<br/>alongside the bet for<br/>future training
```

### What Are the 25 Features?

The features capture **everything the model needs to learn** what makes a winning bet (features 0–20 are the originals, 21–24 were added in the Phase 2–4 pipeline audit):

| #   | Feature                   | Category | What It Captures                                        |
| --- | ------------------------- | -------- | ------------------------------------------------------- |
| 0   | `ev_pct`                  | Value    | How much edge (EV%) this bet has                        |
| 1   | `sharp_true_prob`         | Value    | Pinnacle's vig-removed probability                      |
| 2   | `soft_odds`               | Odds     | Raw soft bookmaker odds                                 |
| 3   | `adjusted_soft_odds`      | Odds     | Soft odds after commission                              |
| 4   | `implied_prob_gap`        | Value    | Gap between sharp and soft implied probability          |
| 5   | `tick_count`              | Movement | How many odds updates recorded (market liquidity)       |
| 6   | `time_to_kickoff_min`     | Market   | Minutes until match starts                              |
| 7   | `movement_pct_sharp`      | Movement | How much sharp odds moved from opening                  |
| 8   | `movement_pct_soft`       | Movement | How much soft odds moved from opening                   |
| 9   | `steam_move_sharp`        | Movement | Binary: sudden sharp movement detected?                 |
| 10  | `steam_move_soft`         | Movement | Binary: sudden soft movement detected?                  |
| 11  | `sharp_direction`         | Movement | Is sharp line going up (+1) or down (-1)?               |
| 12  | `soft_direction`          | Movement | Is soft line going up (+1) or down (-1)?                |
| 13  | `convergence_rate`        | Movement | How fast soft odds are converging toward sharp          |
| 14  | `tick_velocity`           | Movement | Rate of odds updates per minute                         |
| 15  | `provider_count`          | Market   | How many bookmakers offer this market                   |
| 16  | `opening_sharp_odds`      | Odds     | Earliest recorded sharp odds (line origin)              |
| 17  | `market_type_encoded`     | Market   | Market type (Match Result=0, Total Goals=1, AH=2, etc.) |
| 18  | `is_asian_line`           | Market   | Is this a quarter-ball Asian line?                      |
| 19  | `kelly_fraction_raw`      | Staking  | Raw Kelly fraction (optimal stake sizing)               |
| 20  | `vig_pct`                 | Staking  | Sharp bookmaker's overround                             |
| 21  | `competition_tier`        | Market   | Competition quality tier (1=top, 2=mid, 3=low)          |
| 22  | `hours_since_line_opened` | Market   | How long the sharp line has been available              |
| 23  | `sharp_soft_spread`       | Value    | Raw odds gap between soft and implied sharp             |
| 24  | `num_markets_same_event`  | Market   | Active markets on this event (not just value bets)      |

> [!NOTE]
> Features are stored as a JSON array in `bets.ml_features`. After the bet settles (won/lost), a labelled row is written to `ml_training_examples` — the canonical deduplicated training corpus. The features are the input, the outcome is the label.

---

## Part 2: How Training Happens

Training runs as a **Cloud Run Job** (or locally via `python -m app.job`). It is NOT automatic — you trigger it manually when you have enough settled bets.

Training data now lives in the `ml_training_examples` table (canonical, deduplicated by `(source_bet_id, example_type)`).

### Training Pipeline — Step by Step

```mermaid
graph TD
    START["🚀 Training Job Starts"] --> LOAD
    LOAD["📥 Step 1: Load Data<br/>Load from ml_training_examples<br/>(canonical training corpus)"] --> CHECK
    CHECK{"❄️ Step 2: Cold Start Check<br/>Do we have ≥200 labelled examples?"}
    CHECK -->|"No (too few)"| EXIT_COLD["⏹ Exit: Not enough data yet<br/>Come back when more bets settle"]
    CHECK -->|"Yes"| CPCV

    CPCV["🔀 Step 3: CPCV Splitting<br/>Split bets into 10 time-ordered groups<br/>Generate 45 train/test combinations"] --> FOLD_TRAIN

    FOLD_TRAIN["🏋️ Step 4: Fold Training<br/>For each of 45 combinations:<br/>• Train LightGBM on train split<br/>• Predict on held-out test split<br/>• Record Sharpe ratio per fold"] --> METRICS

    METRICS["📊 Step 5: Compute Quality Metrics<br/>• AUC-ROC (classification accuracy)<br/>• DSR (Deflated Sharpe Ratio)<br/>• Calibration Error<br/>• Score-bucket monotonicity<br/>• OOS ROI"] --> GATE

    GATE{"🚦 Step 6: Quality Gate<br/>AUC-ROC > 0.52 AND DSR > 0.8?"}
    GATE -->|"FAIL"| REJECT["❌ Model Rejected<br/>Write audit row (status='validated')<br/>Old model stays active"]
    GATE -->|"PASS"| FINAL

    FINAL["🎓 Step 7: Final Training<br/>Train on ALL data (no holdout)<br/>This is the model we'll deploy"] --> SHAP

    SHAP["🔬 Step 8: SHAP Analysis<br/>Compute feature importance<br/>to understand what the model learned"] --> EXPORT

    EXPORT["📦 Step 9: Export<br/>Convert LightGBM → ONNX format<br/>Upload to Google Cloud Storage"] --> DEPLOY

    DEPLOY["🚀 Step 10: Deploy<br/>Write ml_models row (status='deployed')<br/>Retire previous model<br/>Engine auto-detects within 60s"]

    style START fill:#2563eb,color:white
    style EXIT_COLD fill:#ef4444,color:white
    style REJECT fill:#ef4444,color:white
    style DEPLOY fill:#22c55e,color:white
```

### What is CPCV? (The Secret Sauce Against Overfitting)

Regular cross-validation (like K-Fold) shuffles data randomly — this is **dangerous** for time-series data like betting because future data leaks into the training set. CPCV (Combinatorial Purged Cross-Validation) solves this:

```mermaid
graph LR
    subgraph TIMELINE["Time-Ordered Bets (oldest → newest)"]
        G1["Group 1<br/>Jan bets"]
        G2["Group 2<br/>Feb bets"]
        G3["Group 3<br/>Mar bets"]
        G4["Group 4<br/>Apr bets"]
        G5["Group 5<br/>May bets"]
    end

    subgraph PATH1["Path 1: Test = Groups 1,2"]
        T1["🟥 Test"] ~~~ TR1["🟩 Train (purged)"]
    end

    subgraph PATH2["Path 2: Test = Groups 2,4"]
        TR2A["🟩 Train"] ~~~ T2A["🟥 Test"] ~~~ TR2B["🟩 Train (purged)"] ~~~ T2B["🟥 Test"] ~~~ TR2C["🟩 Train"]
    end

    G1 --> G2 --> G3 --> G4 --> G5

    style G1 fill:#334155,color:#e2e8f0
    style G2 fill:#334155,color:#e2e8f0
    style G3 fill:#334155,color:#e2e8f0
    style G4 fill:#334155,color:#e2e8f0
    style G5 fill:#334155,color:#e2e8f0
```

**Key concepts:**

- **10 groups, pick 2 for testing** → C(10,2) = **45 different train/test paths**
- **Purging**: removes training rows that overlap with test events (same match)
- **Embargo**: removes a 1% buffer zone around test boundaries to prevent data leakage
- Result: **45 honest out-of-sample evaluations** instead of the usual 3-5 from walk-forward

### Quality Gates — What They Mean

| Metric                        | Threshold | Plain English                                                                                                               |
| ----------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| **AUC-ROC**                   | > 0.52    | "Can the model rank winners above losers better than a coin flip?"                                                          |
| **DSR** (Deflated Sharpe)     | > 0.80    | "After accounting for how many model variants we tried, is the performance still statistically significant? Not just luck?" |
| **Calibration Error**         | (soft)    | "When the model says 70%, do ~70% of bets actually win? Lower is better."                                                   |
| **Score-bucket monotonicity** | (soft)    | "Higher-scored bets should have higher win rates. If not, the model is confused."                                           |

> [!NOTE]
> PBO (Probability of Backtest Overfitting) is computed and logged for audit purposes, but is **not** a hard deployment gate. With the current single-trial setup, PBO always returns 0.0 and is meaningless.

> [!IMPORTANT]
> If the hard gates fail, the model is **rejected** — it gets recorded in `ml_models` with `status='rejected'` for audit purposes, but the previous deployed model stays active. No bad model can accidentally go live.

---

## Part 3: What Happens After Training

Once a model passes quality gates and gets deployed, a chain of automatic events kicks in:

```mermaid
sequenceDiagram
    participant JOB as Training Job (Python)
    participant GCS as Google Cloud Storage
    participant DB as Postgres (ml_models)
    participant ENG as Engine (Node.js)
    participant SCORER as ONNX Scorer
    participant STAKER as Kelly Staker
    participant PLACER as Auto-Placer

    JOB->>GCS: Upload model.onnx (v2)
    JOB->>DB: INSERT ml_models (status='deployed', v2)
    JOB->>DB: UPDATE ml_models SET status='retired' WHERE v1

    Note over ENG: Every 60 seconds...
    ENG->>DB: SELECT * FROM ml_models WHERE status='deployed'
    DB-->>ENG: Version 2 found (was v1 or none)
    ENG->>GCS: Download model-v2.onnx → .ml-models/
    ENG->>SCORER: Hot-reload ONNX session (no restart needed)

    Note over ENG: On every value bet detection...
    ENG->>SCORER: scoreBatch([features_1, features_2, ...])  (25-dim each)
    SCORER-->>ENG: [0.87, 0.23, ...]
    ENG->>STAKER: computeAdjustedKelly(baseKelly, 0.87, features)
    STAKER-->>ENG: adjustedKelly = 0.042 (bet more!)
    ENG->>STAKER: computeAdjustedKelly(baseKelly, 0.23, features)
    STAKER-->>ENG: adjustedKelly = 0 (skip this bet!)
    ENG->>PLACER: Only place bet 1 (score 0.87 > 0.4 threshold)
```

### The ML Scoring Pipeline in the Engine

Every 500ms when new odds arrive, this happens **automatically** inside the Reactive Detector (features are re-extracted for all live bets each pass to keep time-moving signals fresh):

```
Odds change detected (or periodic rescore tick)
    ↓
detectAllValueBetsIncremental()    →  finds value bets
    ↓
extractFeatures(bet)               →  [5.56, 0.285, 3.70, ..., 6.54] (25-dim)
    ↓
scoreBatch(featureVectors)         →  [0.87, 0.23, 0.91, ...]
    ↓
computeAdjustedKelly(kelly, score) →  dynamic stake sizing
    ↓
maybeAutoPlace(bet, score, kelly)  →  only if score ≥ 0.4
    ↓
persistValueBets(enrichedBets)     →  save ml_features, ml_score, ml_kelly to DB
```

### How the Staker Adjusts Your Bet Size

The staker doesn't just use the ML score — it considers **multiple signals** from the feature vector:

```mermaid
graph TD
    BASE["Base Kelly Fraction<br/>(from EV calculation)"] --> SCORE_CHECK{"ML Score ≥ 0.4?"}
    SCORE_CHECK -->|"No"| SKIP["❌ Return 0<br/>Skip this bet entirely"]
    SCORE_CHECK -->|"Yes"| SCALE

    SCALE["📈 Score Scaling<br/>0.4 → 0.5× multiplier<br/>0.7 → 1.0× multiplier<br/>1.0 → 1.5× multiplier"] --> CONV

    CONV{"Convergence Rate < 0?<br/>(soft moving toward sharp)"}
    CONV -->|"Yes"| PENALTY["⚠️ Convergence Penalty<br/>multiplier × (1 + convergence)<br/>Max penalty: 0.5×"]
    CONV -->|"No"| PERSIST
    PENALTY --> PERSIST

    PERSIST{"Tick Count > 10?<br/>(bet persisted many updates)"}
    PERSIST -->|"Yes"| BONUS1["✅ Persistence Bonus<br/>multiplier × 1.2"]
    PERSIST -->|"No"| STEAM
    BONUS1 --> STEAM

    STEAM{"Steam Move on Sharp?<br/>(Pinnacle moved suddenly)"}
    STEAM -->|"Yes"| BONUS2["🔥 Steam Bonus<br/>multiplier × 1.3"]
    STEAM -->|"No"| CAP
    BONUS2 --> CAP

    CAP["🔒 Cap at 2× base Kelly<br/>Final adjusted stake"]

    style SKIP fill:#ef4444,color:white
    style CAP fill:#22c55e,color:white
```

---

## Part 4: How to See the Effects

### Before Training (Current State — No Model Deployed)

Without a model, the scorer runs in **pass-through mode**: every bet gets `mlScore = 1.0`, which means:

- ✅ Every value bet that passes EV% threshold gets auto-placed
- ✅ All bets use the same base Kelly fraction
- ✅ Features are still being collected and stored for future training

### After Training (Model Deployed)

You'll see the ML impact in several places:

#### 1. Bets History Table

Each bet row will have:

- **`ml_score`**: The model's P(profitable) prediction (0 to 1)
- **`ml_kelly_adjusted`**: The dynamically adjusted Kelly fraction
- **`ml_features`**: The full 21-dim feature vector (viewable in Feature Inspector)

#### 2. Engine Logs

```
[MLScorer] Model v2 loaded successfully (.ml-models/model-v2.onnx)
[ReactiveDetector] Pass #1234: 5 dirty → 12 value bets (45ms)
```

You'll also see bets being **skipped** when their ML score is below 0.4:

- Before ML: "12 value bets → 12 placed"
- After ML: "12 value bets → 8 placed (4 filtered by ML)"

#### 3. ML Scorer Status (Engine HTTP API)

```json
{
  "modelLoaded": true,
  "modelVersion": 2,
  "featureCount": 21,
  "totalScored": 4521,
  "avgInferenceMs": 0.3,
  "lastInferenceMs": 0.2
}
```

#### 4. ml_models Table

```
id       | version | status   | oos_auc_roc | deflated_sharpe | pbo  | training_samples
---------|---------|----------|-------------|-----------------|------|------------------
01HX...  | 1       | retired  | 0.6842      | 0.8234          | 0.32 | 847
01HY...  | 2       | deployed | 0.7156      | 0.8912          | 0.28 | 1203
```

---

## Part 5: How to Utilize It

### Step-by-Step Usage

```mermaid
graph TD
    A["📊 Phase 1: Collect Data<br/>(CURRENT STAGE)<br/>Let the engine run normally.<br/>Every bet auto-stores 25 features.<br/>Wait for bets to settle."] --> B

    B{"Do you have ≥200<br/>labelled training examples?"}
    B -->|"Not yet"| WAIT["⏳ Keep running the engine.<br/>All bets auto-collect features.<br/>Check: SELECT COUNT(*) FROM<br/>ml_training_examples<br/>WHERE label IS NOT NULL"]
    WAIT --> B

    B -->|"Yes!"| C["🏋️ Phase 2: Train<br/>Run the training job:<br/>cd services/optimizer<br/>source .venv/bin/activate<br/>python -m app.job"]

    C --> D{"Did the model<br/>pass quality gates?"}
    D -->|"Rejected<br/>(AUC < 0.52 or DSR < 0.8)"| E["🔧 Phase 2b: Iterate<br/>• Collect more data<br/>• Review feature importance<br/>• Wait for more diverse outcomes"]
    E --> B

    D -->|"Passed!"| F["🚀 Phase 3: Deploy<br/>Model auto-uploads to GCS.<br/>Engine detects within 60s.<br/>ONNX scorer hot-reloads."]

    F --> G["📈 Phase 4: Monitor<br/>• Watch which bets get filtered (score < 0.4)<br/>• Compare win rates: ML-placed vs ML-filtered<br/>• Check ml_models table for metrics"]

    G --> H["🔄 Phase 5: Retrain<br/>Every 2-4 weeks, rerun the job.<br/>New settled bets improve the model.<br/>Old model auto-retires."]
    H --> C

    style A fill:#2563eb,color:white
    style WAIT fill:#f59e0b,color:black
    style F fill:#22c55e,color:white
```

### Commands You'll Use

| Action                           | Command                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| **Check training example count** | `SELECT COUNT(*) FROM ml_training_examples WHERE label IS NOT NULL;`                         |
| **Run training**                 | `cd services/optimizer && uv run python -m app.job`                                          |
| **Check deployed model**         | `SELECT version, status, oos_auc_roc, deflated_sharpe FROM ml_models ORDER BY version DESC;` |
| **Run verification**             | `npx tsx scripts/ml-verify.ts`                                                               |
| **Check model in engine**        | Engine HTTP API → ML scorer status endpoint                                                  |

### What to Look For After Deployment

| Metric                           | Good Sign                                                | Bad Sign                                                                |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Win rate of ML-placed bets**   | Higher than overall win rate                             | Same or lower                                                           |
| **Win rate of ML-filtered bets** | Lower than overall (the model correctly filtered losers) | Higher (model is filtering good bets!)                                  |
| **ROI**                          | Improving over time as more data → better model          | Declining (model may be stale)                                          |
| **Bets filtered ratio**          | 10-30% filtered (removing noise)                         | >60% filtered (model too aggressive) or 0% (model isn't discriminating) |

### The Feedback Loop

```mermaid
graph LR
    A["🎰 Engine detects<br/>value bets"] --> B["📊 ML scores &<br/>filters them"]
    B --> C["💰 Placed bets<br/>settle (win/lose)"]
    C --> D["📥 Settled outcomes<br/>become training data"]
    D --> E["🏋️ Retrain model<br/>on more data"]
    E --> F["📦 Deploy better<br/>model"]
    F --> B

    style A fill:#3b82f6,color:white
    style B fill:#8b5cf6,color:white
    style C fill:#f59e0b,color:black
    style D fill:#22c55e,color:white
    style E fill:#ef4444,color:white
    style F fill:#06b6d4,color:white
```

> [!TIP]
> **The engine is always collecting data.** Features are stored on every value bet detection. Once 200+ labelled training examples have accumulated (settled bets with outcomes), training can produce a deployable model.

---

## Summary — The Complete Data Flow

```
┌─────────────────────────── REAL-TIME (Engine, every 500ms) ────────────────────────────┐
│                                                                                         │
│  Odds change → Detect value bet → Extract 25 features → Score with ONNX model           │
│                                   → Adjust Kelly stake → Auto-place if score ≥ 0.4      │
│                                   → Persist bet + features + score to DB                 │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          │ (bets settle over days/weeks)
                                          ▼
┌───────────────────────── TRAINING (Python Job, on-demand) ─────────────────────────────┐
│                                                                                         │
│  Load ml_training_examples → CPCV split (45 paths) → Train LightGBM per fold            │
│  → Compute AUC-ROC + DSR → Quality gate → Train final model on all data                │
│  → Export ONNX → Store blob in ml_models + upload GCS → Engine hot-reloads               │
│                                                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

**The model learns from YOUR betting history to optimize YOUR future bets.** The more bets that settle, the smarter it gets.
