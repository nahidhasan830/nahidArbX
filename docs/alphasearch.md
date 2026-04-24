# AlphaSearch — User Guide

> **What this is:** AlphaSearch is the parameter-optimization workbench at
> [`/lab/alphasearch`](/lab/alphasearch). It sweeps through configurations of
> filters + sizing rules and tells you which would have produced the highest,
> most consistent ROI on your historical bets — _honestly_, with proper
> statistical safeguards, not by overfitting noise.

> **What it's not:** a prediction model. It doesn't tell you which bet to
> place tomorrow. It tells you which _configuration_ of your existing
> value-bet detection rules works best on your real history.

Audience: anyone running this app, technical or not. Read time ≈ 15 minutes.

---

## 1. The 90-second mental model

You already detect value bets. They land in the `bets` table with full
metadata: EV%, odds, sport, league, soft book, sharp book, market type,
stake, P&L outcome.

If you ran the system with **only bets above 3% EV at NineWickets-SB on
pre-match Asian Handicaps with quarter-Kelly sizing**, would your bottom
line be better than today's global "anything above 2% EV" setup?

That's the question. AlphaSearch answers it by:

1. **Loading every settled bet** into memory.
2. **Sampling thousands of configurations** of (EV gate, Kelly fraction,
   odds range, market types, soft providers, sizing scheme, …).
3. **Scoring each one** on multiple held-out time slices of your bet history
   (so they can't peek at the answer).
4. **Discounting their scores** for the number of trials we ran (the more we
   try, the more luck looks like skill — we account for that mathematically).
5. **Showing you the trade-offs** as a Pareto frontier: which configs offer
   the best ROI for the least drawdown, with confidence intervals you can
   trust.

The output isn't "the one true config" — it's a small menu of well-validated
trade-offs you can pick from based on your risk tolerance.

---

## 2. Use cases

### "Find the best config across all my data."

1. Open `/lab/alphasearch`.
2. Click **New run**.
3. Leave defaults (Ensemble sampler, 2,000 trials).
4. Click **Start run**.
5. Wait 3-10 minutes (longer if you have lots of bets).
6. Click into the run; sort the trial table by **Composite** score, descending.
7. Top trial = the optimizer's best pick. Click for full config.

### "Test if a stricter EV gate would have been better."

The default search space includes `min_ev_pct` from 1.0 to 6.0%. After a
run, in the trial table:

- Click the top-scoring trial.
- Note its `min_ev_pct` value.
- Compare its OOS ROI to your current global setting (2.0%).

### "I only care about Asian Handicaps."

(Phase 2 search-space editor.) For now you can submit a run and filter
trials whose `market_types` config includes `ASIAN_HANDICAP` to see how it
performs.

### "I want to schedule a daily run."

Coming in Phase 2 (Schedules tab).

---

## 3. Reading the UI

### Runs tab

Every submitted run with status, progress, and best-so-far score. Auto-refreshes
every 5 seconds.

### Run detail

Click any run to see:

- **Header card** — algorithm, RNG seed, trials completed, best composite score.
- **Pareto scatter** — every trial as a dot, X = max drawdown, Y = OOS ROI.
  Blue dots are on the Pareto frontier (best trade-offs). Bigger dots = more
  bets survived the filters.
- **Trials table** — every trial with its key metrics. Click any row for the
  full configuration + per-fold breakdown.
- **Pareto-only filter** — hide dominated trials.

---

## 4. The technology stack

```
You (browser)
  ↓ HTTP
Next.js (existing app)
  ↓ POST  /run/start  (HTTP, HMAC auth)
Python sidecar (services/optimizer)
  ↓ writes trials
Postgres (shared)
  ↑ reads trials
Next.js → /lab/alphasearch UI
```

- **Python sidecar** runs Optuna (search), skfolio (cross-validation), arch
  (bootstrap), pypbo (overfit penalties), Polars (in-memory data engine).
- **Postgres is the bus.** Both sides read/write `optimization_runs` +
  `optimization_trials`. The sidecar is stateless w.r.t. its own results —
  if it crashes mid-run, nothing is lost; you just resume.
- **Cloud Run** hosts the sidecar; **Cloud SQL** is the existing Postgres.
  Min instances = 0 (scale-to-zero), so the sidecar costs nothing when idle.

See [`services/optimizer/README.md`](../services/optimizer/README.md) for
engineering notes on the sidecar itself.

---

## 4a. Data scope vs search space — pick the right knob <a id="data-scope"></a>

Two completely different things, both in the submit-run sheet:

| Concept                                     | What it does                                                                    | Example                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Data scope** _(applied BEFORE search)_    | Narrows which historical bets enter the analysis at all                         | "Exclude all NineWickets-Exchange bets from this run" |
| **Search space** _(swept BY the optimizer)_ | Tells the optimizer which parameter dimensions to tune within the included data | "Try `min_ev_pct` between 1.0 and 6.0"                |

If you turn off NW-Exchange via **data scope**, the optimizer never sees those rows. They don't exist for this run — every CV split, bootstrap CI, and Pareto trial is computed only on the data you included.

If you turn off NW-Exchange via the **search-space subset dimension**, you're telling the optimizer to _try sampling_ without NW-Exchange among other combinations. The optimizer might still decide the best config includes it.

**Rule of thumb:**

- Use **data scope** when you want to _force exclusion_ — "this provider is buggy / unreliable / I don't trust the data".
- Use **search-space subset** when you want the optimizer to _discover_ whether a provider helps or hurts.

Defaults: data scope = include everything; search space = sweep all 11 dimensions.

The submit-run sheet shows a live "X of Y bets included" preview as you toggle data-scope filters, so you can see the impact immediately. CPCV needs ≥50 surviving bets per run — if you over-filter, the run will fail at startup with a clear error.

---

## 5. The algorithms in plain English

### CPCV — Combinatorial Purged Cross-Validation <a id="cpcv"></a>

**One-line:** splits your time-ordered bet history into chunks; tests each
configuration on every combination of held-out chunks.

**Why it matters:** with 10 chunks and 2 held out at a time, you get **45
out-of-sample paths** instead of the 3-5 you'd get from simple walk-forward.
More OOS paths = more trustworthy result.

**What to look for:** the per-fold breakdown in the trial drawer — if a
config's OOS ROI is consistently positive across most folds, that's signal.
If half are positive and half are negative, that's noise.

**Source:** López de Prado, _Advances in Financial Machine Learning_, 2018.

### Walk-Forward Analysis (WFA) <a id="walkforward"></a>

**One-line:** train on a window, test on the next window, slide forward.

**Why it matters:** simpler than CPCV; produces a single forward-looking time
series. Good for sanity-checking CPCV results. Phase 2.

### Embargo <a id="embargo"></a>

**One-line:** drop bets near each test boundary so the model can't "peek".

**Why it matters:** in time-series data, bets near each other can leak
information (overlapping events, hot streaks). Embargo removes that leakage.

### Bootstrap CI <a id="bootstrap"></a>

**One-line:** resample your data 1,000 times to compute a confidence
interval around every metric.

**Why it matters:** a point estimate ("ROI is 5%") tells you nothing about
how confident to be. A CI ("[3%, 7%] with 95% confidence") tells you the
real range. We use **stationary block bootstrap** (random-length blocks)
because bet outcomes are mildly autocorrelated.

**What to look for:** wide CIs ⇒ small sample ⇒ less trust.

### Confidence Interval (CI) <a id="ci"></a>

**One-line:** the range your true metric likely lies in.

**Why it matters:** never trust a number without it. A 5% ROI claim with a
±0.5% CI is rock-solid; the same claim with a ±4% CI is barely distinguishable
from zero.

### Optuna ensemble — Random + TPE + NSGA-II <a id="ensemble"></a> <a id="tpe"></a> <a id="nsga2"></a>

**One-line:** three samplers under one study, picking which configs to try
next based on what worked.

- **Random** — uniform sampling. Provably better than grid search above 5
  dimensions ([Bergstra & Bengio
  2012](https://jmlr.csail.mit.edu/papers/v13/bergstra12a.html)). Gives unbiased
  baseline coverage.
- **TPE** (Tree-structured Parzen Estimator) — Bayesian optimizer.
  Learns where good configs cluster and samples there next. 5-10× faster
  convergence than random in high-dim spaces.
- **NSGA-II** — multi-objective genetic algorithm. Returns the Pareto
  frontier directly. Slower per-trial. Phase 2.

**Source:** Optuna 4.x ([optuna.org](https://optuna.org/)).

### Pareto frontier <a id="pareto"></a>

**One-line:** the set of configurations where you can't improve one metric
without making another worse.

**Why it matters:** if config A has higher ROI but bigger drawdown than B,
both can be on the frontier — choose based on your risk tolerance. Maximizing
one metric in isolation is the textbook overfit.

### Composite score <a id="composite-score"></a>

**One-line:** a single number combining ROI, sample size, drawdown, and
overfit penalties.

**Formula:** `shrunk_ROI × log(1 + n) × DSR_multiplier - λ × max_drawdown`

- `shrunk_ROI` shrinks toward zero when sample size is small.
- `log(1 + n)` rewards larger samples.
- `DSR_multiplier` scales by overfit-adjusted confidence.
- `λ × max_drawdown` penalizes scary drawdowns.

The optimizer maximizes this. Sort by Composite for the optimizer's overall
top picks.

### Deflated Sharpe Ratio (DSR) <a id="dsr"></a>

**One-line:** Sharpe ratio adjusted downward for the number of configurations
we tried.

**Why it matters:** if you run 10,000 random strategies, the best one will
look great by sheer luck. DSR mathematically deflates that bias.

**Source:** [Bailey & López de Prado, "The Deflated Sharpe Ratio"
(2014)](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).

### Probabilistic Sharpe Ratio (PSR) <a id="psr"></a>

**One-line:** the probability your _true_ Sharpe exceeds a benchmark.

**Why it matters:** PSR > 0.95 ≈ statistically significant at the 5% level.

### PBO — Probability of Backtest Overfitting <a id="pbo"></a>

**One-line:** how likely it is that your "winner" is just lucky.

**Why it matters:** PBO < 5% is excellent. PBO > 30% means your search space
is too aggressive for your sample size — narrow it or get more data.

**Source:** Bailey, Borwein, López de Prado, Zhu (2017). Phase 2.

### White's Reality Check (WRC) <a id="wrc"></a>

**One-line:** tests whether your best strategy beats a baseline by more than
chance.

**Why it matters:** returns a p-value. < 0.05 means the best config likely
contains real signal vs the baseline. Phase 2.

### Kelly fraction <a id="kelly-fraction"></a>

**One-line:** what fraction of full Kelly to bet (0.25 = quarter Kelly).

**Why it matters:** full Kelly maximizes long-run growth in theory but
causes 50%+ drawdowns in practice. Quarter Kelly is the empirical sweet
spot used by most professionals. We clamp the search to [0.10, 0.50].

---

## 6. How to read a trial

Click any row in the trials table.

**Summary block** (top): the headline metrics with confidence bands.

**Sampled configuration**: the exact filter + sizing values for this trial.
This is what you'd configure if you wanted to use this strategy.

**Per-fold breakdown** (bottom): the same metrics computed separately on
each of the 45 OOS paths. Look for _consistency_ — a config that works on 40
paths and fails on 5 is more trustworthy than one that works on 25 and
fails on 20.

---

## 7. Promoting a strategy

Coming in **Phase 3.** When ready, the trial drawer's "Promote to strategy"
button will:

1. Insert a row in the `strategies` table with the trial's filters + sizing.
2. Mark its status as `candidate` → you flip to `live` when ready.
3. The value detector consults active strategies on every tick — when a
   detected bet matches a strategy's filters, the strategy's sizing rules
   apply (overriding global Kelly settings).
4. Each placed bet records its originating `strategy_id` so we can monitor
   live performance vs the OOS estimate.

---

## 11. Troubleshooting

### Run sits in `queued` forever

The Python sidecar is unreachable. Check:

- `OPTIMIZER_URL` env var is set in `.env` (default `http://localhost:8001`).
- Sidecar process is running (`uv run uvicorn app.main:app --port 8001` in
  `services/optimizer/`).
- Sidecar can reach Postgres (visit `http://localhost:8001/health`).

### Run fails with "Only N settled bets — too few"

You have fewer than 50 settled bets. Either wait for more bets to settle, or
reduce `n_trials` to a small number to test the pipeline.

### Run fails with "sidecar 401"

`OPTIMIZER_SHARED_SECRET` mismatch between Next.js and the sidecar. Both
processes must read the same secret from `.env`.

### All trials report 0 ROI

Probably the search-space filters all configs down to zero surviving bets.
Try a wider odds range or relaxed EV gate.

### Trials are not deterministic

Same `rng_seed` should produce bitwise-identical trial scores. If not:

- Verify pinned `uv.lock` is in use (no auto-upgrades).
- Confirm `bets` table data hasn't changed between runs.

---

## 12. Operating cost & budget

| Component                                  | Monthly cost (moderate use) |
| ------------------------------------------ | --------------------------- |
| Cloud Run sidecar (min=0, ~few daily runs) | $5-10                       |
| Cloud SQL queries (already paying)         | $0 marginal                 |
| Cloud Build (~50 builds/month)             | $0 (free tier)              |
| Artifact Registry storage                  | $0-1                        |
| Secret Manager                             | $0 (free tier)              |
| **Total marginal cost**                    | **≈ $5-15/month**           |

**No AI calls.** AlphaSearch is pure deterministic numerics. The AI cost
safeguards in `CLAUDE.md` don't apply here.

---

## Glossary

See [`lib/lab/glossary.ts`](../lib/lab/glossary.ts) for the per-term
definitions used in UI tooltips. Every tooltip's "Learn more →" link points
back to a section in this document.

## Roadmap

- **Phase 2** — Schedules tab (UI-driven cron), search-space editor, NSGA-II,
  walk-forward, PBO + WRC scoring, onboarding tour.
- **Phase 3** — Promote-to-strategy lifecycle, value-detector integration,
  live metrics convergence display.
- **Phase 4** — XGBoost / LightGBM ML alternative routed through the same
  CPCV harness for apples-to-apples comparison.
- **Phase 5** — Weekly re-validation cron, drift-based auto-pause.
