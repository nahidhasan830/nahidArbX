# ML Training Sidecar

Python service that runs LightGBM model training for the nahidArbX ML Optimizer.
This is the engine behind the ML pipeline at `/lab/ml` in the Next.js app.

> **User-facing documentation lives in the in-app tooltips on `/lab/ml`** (sourced from [`lib/lab/glossary.ts`](../../lib/lab/glossary.ts)).
> This README is for engineers working on the sidecar itself.

## What it does

1. The engine's ML retraining scheduler (`lib/optimizer/scheduler.ts`) triggers
   this Cloud Run Job when retraining criteria are met (enough new settled data).
2. Sidecar loads settled bets + ML feature vectors from Postgres, trains a
   LightGBM classifier using CPCV, evaluates deployment-gate quality metrics
   (DSR, PBO, AUC, score-bucket monotonicity).
3. If the model passes quality gates, it's promoted to `deployed` status in
   `ml_models` and the engine auto-loads the ONNX artifact.
4. The Next.js `/api/ml/retrain` endpoint can also trigger training manually.

The sidecar is **stateless** — all state lives in shared Postgres.

## Stack

| Concern               | Library                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| ML framework          | LightGBM 4.x with isotonic calibration                                            |
| Cross-validation      | [skfolio](https://skfolio.org/) `CombinatorialPurgedCV`                           |
| Bootstrap             | [arch](https://arch.readthedocs.io/) `StationaryBootstrap` (time-series-aware)    |
| Overfit penalties     | Closed-form DSR / PSR + PBO                                                       |
| Data engine           | [Polars](https://pola.rs/) (Rust core, lazy eval)                                 |
| Service               | FastAPI 0.115 + uvicorn                                                           |
| DB                    | SQLAlchemy 2.x + `google-cloud-sql-connector[pg8000]` (mirrors Next.js connector) |
| Package manager       | [uv](https://docs.astral.sh/uv/) (≈10× faster than pip; deterministic `uv.lock`)  |

## Local development

Prereq: Python 3.12, [uv](https://docs.astral.sh/uv/getting-started/installation/),
`gcloud` ADC (`gcloud auth application-default login`), and the same `.env` the
Next.js app uses (for `DATABASE_URL` + `CLOUD_SQL_INSTANCE`).

```bash
cd services/optimizer

# Install deps into a managed venv.
uv sync

# Run the dev server (hot-reload). Reads `.env` two levels up.
uv run uvicorn app.main:app --port 8001 --reload

# Health check.
curl -s localhost:8001/health
```

## Production deployment (Google Cloud)

The sidecar runs as **Cloud Run Job `nahidarbx-optimizer-job`** in
`asia-south1`, in the existing GCP project `nahidarbx-6e73`.

### Redeploy (one-liner)

```bash
bash services/optimizer/redeploy.sh
```

## Module map

```
app/
  main.py          FastAPI app (/run/start, /health)
  config.py        env loading (DB conn, default RNG, max workers)
  db.py            SQLAlchemy session + Cloud SQL connector
  loader.py        load_settled_bets(run_id) → polars.DataFrame
  ml/              LightGBM training + CPCV + deployment gate
```

## Testing

```bash
uv run pytest                  # all tests
uv run ruff check app          # lint
uv run ruff format app         # format
uv run mypy app                # type-check
```

## Cost

At moderate use (scheduled + occasional manual runs), the sidecar costs
roughly **$5–15/month** on Cloud Run with min-instances=0.
Storage stays inside the existing Cloud SQL instance — no new persistent
infrastructure required.
