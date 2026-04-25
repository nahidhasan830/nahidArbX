# Optimisation Sidecar

Python service that runs parameter-optimization sweeps over historical
bets data for the nahidArbX value-bet finder. This is the engine behind the
`/lab/optimisation` workbench in the Next.js app.

> **User-facing documentation lives in the in-app tooltips on `/lab/optimisation`** (sourced from [`lib/lab/glossary.ts`](../../lib/lab/glossary.ts)).
> This README is for engineers working on the sidecar itself.

## What it does

1. Next.js inserts a row into `optimization_runs` (`status='queued'`) and POSTs
   to `/run/start`.
2. Sidecar loads settled bets from Postgres into Polars, runs CPCV / walk-forward
   splits, samples configurations via Optuna (random + TPE + NSGA-II ensemble),
   evaluates each config on every OOS path, computes bootstrap CIs +
   Deflated Sharpe + Probabilistic Sharpe + PBO + White's Reality Check.
3. Each completed trial is written to `optimization_trials` for live UI updates.
4. On completion, summary (Pareto frontier, top-K, DSR-adjusted leader, PBO,
   WRC p-value vs baseline) is written to `optimization_runs.summary`.

The sidecar is **stateless** — all state lives in shared Postgres.

## Stack

| Concern               | Library                                                                           |
| --------------------- | --------------------------------------------------------------------------------- |
| Hyperparameter search | [Optuna](https://optuna.org/) (random + TPE + NSGA-II samplers)                   |
| Cross-validation      | [skfolio](https://skfolio.org/) `CombinatorialPurgedCV`                           |
| Bootstrap             | [arch](https://arch.readthedocs.io/) `StationaryBootstrap` (time-series-aware)    |
| Overfit penalties     | [pypbo](https://github.com/esvhd/pypbo) + closed-form DSR / PSR                   |
| Data engine           | [Polars](https://pola.rs/) (Rust core, lazy eval) — switches to DuckDB > 1M rows  |
| ML (Phase 4)          | XGBoost 2.x + LightGBM 4.x with isotonic calibration                              |
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

Add to your `.env` at the repo root:

```
OPTIMIZER_URL=http://localhost:8001
OPTIMIZER_SHARED_SECRET=<long random string — same on both sides>
```

## Production deployment (Google Cloud)

The sidecar runs on **Cloud Run service `nahidarbx-optimizer`** in
`asia-south1`, in the existing GCP project `nahidarbx-6e73`. **Already
provisioned and live** as of the first push — see "Initial provisioning"
below for what was set up if you ever need to recreate it.

### Redeploy (one-liner)

```bash
bash services/optimizer/redeploy.sh
```

Builds the current source via Cloud Build, deploys to Cloud Run, prints
the new URL. Tags the image with the current git SHA and `latest`.

### Or auto-deploy on `git push` (recommended)

One-time setup via the GCP console (CLI requires browser OAuth):

1. Open [Cloud Build → Triggers](https://console.cloud.google.com/cloud-build/triggers?project=nahidarbx-6e73&supportedpurview=project) for `nahidarbx-6e73` in `asia-south1`.
2. **Connect Repository** → GitHub → install the Cloud Build app on
   `nahidhasan830/nahidArbX`.
3. **Create Trigger**:
   - Name: `optimizer-on-push`
   - Event: Push to a branch · `^main$`
   - **Included files filter (glob):** `services/optimizer/**` ·
     also include `cloudbuild.yaml`
   - Configuration: Cloud Build configuration file (yaml) · `cloudbuild.yaml`
   - Service account: `optimizer-sa@nahidarbx-6e73.iam.gserviceaccount.com`

After this, every push to `main` that touches the sidecar will rebuild +
redeploy automatically. No more manual `redeploy.sh` calls.

### Resources currently provisioned

- **Image registry:** `asia-south1-docker.pkg.dev/nahidarbx-6e73/optimizer/`
- **Service account:** `optimizer-sa@nahidarbx-6e73.iam.gserviceaccount.com`
  with `roles/cloudsql.client` + `roles/secretmanager.secretAccessor`
- **Secrets:** `DATABASE_URL` + `OPTIMIZER_SHARED_SECRET` in Secret Manager
- **Cloud Run service:** scale-to-zero (min=0), max=3 instances, 4 CPU /
  8 GiB, public ingress, HMAC-token auth via `OPTIMIZER_SHARED_SECRET`

### Locking down ingress (later)

Currently `--ingress=all` so the Next.js dev server can reach the sidecar
over the public internet. Auth is the HMAC token (constant-time compare in
`main.py`). Once Next.js also runs on Cloud Run, switch to
`--ingress=internal` in `cloudbuild.yaml` and add a VPC connector — the
sidecar then becomes unreachable from the public internet entirely.

## Module map

```
app/
  main.py          FastAPI app (/run/start, /run/cancel, /health)
  config.py        env loading (DB conn, default RNG, max workers)
  db.py            SQLAlchemy session + Cloud SQL connector
  loader.py        load_settled_bets(run_id) → polars.DataFrame
  search_space.py  declarative dimension spec + Optuna `suggest_*` adapter
  evaluator.py     evaluate_config(config, df, splits) → fold_metrics
  cpcv.py          skfolio CombinatorialPurgedCV wrapper
  walkforward.py   anchored & rolling WFA wrappers          (Phase 2)
  bootstrap.py     arch.bootstrap.StationaryBootstrap → CI
  scoring.py       deflated_sharpe, probabilistic_sharpe, pbo, whites_reality_check, composite
  samplers.py      build_study(algo, seed) → optuna.Study
  pareto.py        extract_pareto(trials) → bool[] on_pareto
  runner.py        run_trial_loop(run_id) — main coroutine
  ml/              Phase 4: XGBoost / LightGBM
```

## Testing

```bash
uv run pytest                  # all tests
uv run pytest tests/test_placebo.py -v    # just the placebo suite
uv run ruff check app          # lint
uv run ruff format app         # format
uv run mypy app                # type-check
```

### Correctness tests (`tests/`)

We ship three tiers of statistical-correctness gates that catch silent
bugs in CPCV / bootstrap / DSR / PSR / PBO / Pareto / Kelly math. None
of these tests touch Postgres — they build synthetic bets via
`tests/conftest.py::make_synthetic_bets`, then hit the pure pipeline
directly.

- **`test_placebo.py`** — zero-edge bets (P(win) = 1/odds exactly) run
  through many evaluator configs. No config may report a confidently
  positive OOS ROI (95% CI lower bound > 0). If this fails, the
  statistical layer is leaking — look for look-ahead, embargo off-by-one,
  or bootstrap seed issues. This is the single most valuable gate.
- **`test_determinism.py`** — same input + same seed must produce
  bitwise-identical output for `evaluate_trial`, `make_cpcv_splits`,
  `stationary_bootstrap_ci`, `deflated_sharpe`, `probabilistic_sharpe`,
  and `pbo_score`. Catches silent non-determinism from lib upgrades.
- **`test_known_answer.py`** — bets with a universal +3% edge (P(win)
  = 1/odds + 0.03). The default config MUST detect a meaningfully
  positive OOS ROI with CI lower bound > 0. Placebo proves we don't
  hallucinate edges; known-answer proves we find real ones.

Run these before and after every sidecar redeploy. They're fast (< 30s
total) and run offline — no DB, no secrets needed.

A separate snapshot test in `tests/test_pnl_parity.py` pins our Python
`compute_pnl` output to the canonical Next.js implementation in
`lib/db/repositories/bets.ts::computePnl()` for a fixed sample. **Do not
break this test** — TS/Python evaluator divergence is a class of bugs we
explicitly designed against.

## Determinism contract

Re-running the same `optimization_runs` row (same `search_space`,
`search_algorithm`, `rng_seed`, `cv_strategy`) MUST produce bitwise-identical
trial scores. We rely on this for audit and verification.

To preserve it:

- All randomness must seed off `optimization_runs.rng_seed`.
- Pinned deps via `uv.lock`.
- DataFrame row order is sorted by `(event_start_time, id)` before splitting.
- No wall-clock-based logic anywhere in the trial loop.

## Cost

At moderate use (one daily run + occasional manual runs), the sidecar costs
roughly **$5–15/month** on Cloud Run with min-instances=0 and max=3.
Storage stays inside the existing Cloud SQL instance — no new persistent
infrastructure required.
