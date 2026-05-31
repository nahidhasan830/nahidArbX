# ML Training Sidecar

Python service that runs LightGBM model training for the nahidArbX ML Optimizer.
This is the engine behind the ML pipeline at `/lab/ml` in the Next.js app.

> **User-facing documentation lives in the in-app tooltips on `/lab/ml`** (sourced from [`lib/lab/glossary.ts`](../../lib/lab/glossary.ts)).
> This README is for engineers working on the sidecar itself.

## What it does

1. The engine's ML retraining loop (`lib/optimizer/scheduler.ts`) triggers
   this Cloud Run Job whenever the canonical training corpus has grown by
   ≥`ML_RETRAIN_GROWTH_STEP` (200 examples) since the last deployed model. There
   is no cadence, no enabled toggle — operators always have a manual
   "Retrain" button on the dashboard via `/api/ml/retrain`.
2. Sidecar loads training data from `ml_training_examples` table (canonical
   deduplicated corpus with precedence: `placed_settled` > `settled_detected` >
   `shadow_scored`), trains a LightGBM classifier using event-aware
   CPCV (Combinatorial Purged Cross-Validation), evaluates deployment-gate
   quality metrics (AUC-ROC, Deflated Sharpe Ratio, score-bucket monotonicity,
   calibration error).
3. If the model passes basic model-sanity gates, it is promoted to `deployed`
   with `permission_level='observe'` at minimum so the engine can collect live
   prediction audit rows. Economic policy gates (policy sample size, ROI, DSR,
   and baseline outperformance) are required only before ML can skip bets or
   change stake sizing.
4. The ONNX artifact is stored as a blob in `ml_models`, registered with Vertex
   AI, and served through the shared Vertex prediction endpoint. The engine
   auto-loads the latest deployed endpoint via polling.
5. The Next.js `/api/ml/retrain` endpoint can also trigger training manually.

The sidecar is **stateless** — all state lives in shared Postgres.

## Stack

| Concern          | Library                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| ML framework     | LightGBM 4.x with isotonic calibration                                            |
| Cross-validation | Event-aware Combinatorial Purged CV (custom `cpcv.py`)                            |
| Bootstrap        | [arch](https://arch.readthedocs.io/) `StationaryBootstrap` (time-series-aware)    |
| Overfit metrics  | Closed-form DSR / PSR (PBO computed but not a hard deployment gate)               |
| Data engine      | [Polars](https://pola.rs/) (Rust core, lazy eval)                                 |
| Execution        | Cloud Run Job (batch entry via `python -m app.job`, no HTTP server)               |
| DB               | SQLAlchemy 2.x + `google-cloud-sql-connector[pg8000]` (mirrors Next.js connector) |
| Package manager  | [uv](https://docs.astral.sh/uv/) (≈10× faster than pip; deterministic `uv.lock`)  |

## Local development

Prereq: Python 3.12, [uv](https://docs.astral.sh/uv/getting-started/installation/),
`gcloud` ADC (`gcloud auth application-default login`), and the same `.env` the
Next.js app uses (for `DATABASE_URL` + `CLOUD_SQL_INSTANCE`).

```bash
cd services/optimizer

# Install deps into a managed venv.
uv sync

# Run training job locally.
uv run python -m app.job
```

## Production deployment (Google Cloud)

The sidecar runs as **Cloud Run Job `nahidarbx-optimizer-job`** in
`asia-south1`, in the existing GCP project `nahidarbx-6e73`.

### Redeploy (one-liner)

```bash
bash services/optimizer/redeploy.sh
```

## Key parameters

| Parameter            | Value | Where                                                |
| -------------------- | ----- | ---------------------------------------------------- |
| Feature count        | 22    | `app/feature_names.py`, `lib/ml/feature-contract.ts` |
| Feature version      | 1     | Same files                                           |
| Cold start threshold | 200   | `app/config.py`, `lib/shared/constants.ts`           |
| Retrain growth step  | 200   | `lib/shared/constants.ts`                            |
| CPCV groups          | 10    | `app/cpcv.py`                                        |
| CPCV test size       | 2     | `app/cpcv.py`                                        |
| AUC-ROC gate         | 0.55  | `app/deployment_gate.py`                             |
| DSR active gate      | 0.60  | `app/deployment_gate.py`                             |

## Module map

```
app/
  __init__.py        Package marker
  config.py          env loading (DB conn, default RNG, thresholds)
  db.py              SQLAlchemy session + Cloud SQL connector
  loader.py          load training data → polars.DataFrame
  cpcv.py            Event-aware Combinatorial Purged CV
  trainer.py         LightGBM training + CPCV evaluation
  scoring.py         DSR, calibration, score-bucket analysis
  deployment_gate.py Quality gate decisions
  exporter.py        ONNX export + GCS upload + ml_models write
  bootstrap.py       Stationary bootstrap for DSR
  feature_names.py   Canonical feature names (synced with TS)
  job.py             Cloud Run Job entry point (python -m app.job)
```

## Testing

```bash
uv run python -m pytest        # all tests
uv run ruff check app          # lint
uv run ruff format app         # format
uv run mypy app                # type-check
```

## Cost

At moderate use (auto-retrains on each 200-example corpus growth step + occasional manual runs),
the sidecar costs roughly **$5–15/month** on Cloud Run with min-instances=0.
Storage stays inside the existing Cloud SQL instance — no new persistent
infrastructure required.
