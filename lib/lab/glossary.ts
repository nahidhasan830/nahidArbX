/**
 * Single-source-of-truth registry of technical terms shown in the Lab UI.
 *
 * Every `<TermTooltip>` reads from this map. Tooltip UX is "info icon next to
 * the label, hover/click for the definition + a 'Learn more' link to the
 * relevant section in `docs/alphasearch.md`".
 *
 * Format per term:
 *   short:  one plain-English line shown as the primary tooltip text
 *   long:   2-3 sentences with an example or implication, shown below `short`
 *   learnMoreHref: anchor in `docs/alphasearch.md` for the full explainer
 */

export interface GlossaryEntry {
  short: string;
  long?: string;
  learnMoreHref?: string;
}

export type TermId = keyof typeof GLOSSARY;

export const GLOSSARY = {
  // ── Performance metrics ──────────────────────────────────────────────
  roi: {
    short: "Return on investment — net profit as a percentage of total stakes.",
    long: "ROI of 5% means for every 100 units staked, you ended up 5 units richer (averaged across all bets). Higher is better, but a small sample can mislead — always check the confidence interval.",
    learnMoreHref: "/docs/alphasearch.md#roi",
  },
  clv: {
    short:
      "Closing Line Value — how much better your placed odds were than the market's final odds.",
    long: "Positive CLV is the strongest leading indicator that you're picking real edges, even before outcomes settle. ~50 bets is enough to see a CLV signal; ROI takes 2,000+ to converge.",
    learnMoreHref: "/docs/alphasearch.md#clv",
  },
  sharpe: {
    short: "Sharpe ratio — risk-adjusted return (mean / standard deviation).",
    long: "Higher is better. Sharpe accounts for variance — an ROI of 5% with low variance beats 5% with wild swings.",
    learnMoreHref: "/docs/alphasearch.md#sharpe",
  },
  sortino: {
    short:
      "Sortino ratio — like Sharpe, but only penalizes downside volatility.",
    long: "More appropriate than Sharpe for asymmetric returns (which betting P&L is). Higher is better.",
    learnMoreHref: "/docs/alphasearch.md#sortino",
  },
  drawdown: {
    short:
      "Max drawdown — the largest peak-to-trough loss the strategy ever experienced.",
    long: "A 30% drawdown means at some point your bankroll dropped 30% from its highest point. Smaller is better.",
    learnMoreHref: "/docs/alphasearch.md#drawdown",
  },
  sample_size: {
    short: "Number of bets that survived this configuration's filters.",
    long: "More is better — confidence intervals shrink as 1/√N. Trials with fewer than ~50 surviving bets are flagged 'low confidence'.",
    learnMoreHref: "/docs/alphasearch.md#sample-size",
  },
  win_rate: {
    short: "Percentage of decisive bets that won.",
    long: "Not the same as profitability — a system can win 40% of the time and still be very profitable if the wins pay big odds.",
  },

  // ── CV + bootstrap ─────────────────────────────────────────────────────
  cpcv: {
    short:
      "CPCV — splits your bets into chunks, then tests the rule on every chunk it wasn't trained on.",
    long: "Think of it like marking an exam: you hide 2 out of 10 chapters, teach on the other 8, then test on the hidden 2 — and you do that for every possible hide-2 combination. 10 groups × 2 test = 45 mini-exams (OOS paths). More mini-exams → more confidence the rule's edge is real, not luck. Our default.",
    learnMoreHref: "/docs/alphasearch.md#cpcv",
  },
  walkforward: {
    short:
      "Walk-forward — train on old bets, test on newer bets, slide the window forward in time.",
    long: "Example: train on Jan-Jun, test on Jul. Then train on Feb-Jul, test on Aug. Closer to how you'd actually deploy a live strategy, but gives you fewer test points than CPCV. Use it to sanity-check a CPCV result.",
    learnMoreHref: "/docs/alphasearch.md#walkforward",
  },
  embargo: {
    short:
      "Number of bets dropped from training around each test boundary, to prevent leakage.",
    long: "Bets near each other in time can share information (overlapping events, hot streaks). Embargo removes those bets from training so the model can't 'cheat'.",
    learnMoreHref: "/docs/alphasearch.md#embargo",
  },
  bootstrap: {
    short:
      "Stationary block bootstrap — resamples your data thousands of times to get a confidence interval.",
    long: "We use 1,000 resamples with random-length blocks (preserves time-series autocorrelation). Output is a low/high CI band on every metric.",
    learnMoreHref: "/docs/alphasearch.md#bootstrap",
  },
  ci: {
    short: "Confidence Interval — the range your true metric likely lies in.",
    long: "A 5% ROI with a 95% CI of [3%, 7%] means we're 95% confident the true ROI is between 3 and 7. Wide CIs = small sample = less trust.",
    learnMoreHref: "/docs/alphasearch.md#ci",
  },

  // ── Multi-objective + Pareto ───────────────────────────────────────────
  pareto: {
    short:
      "Pareto Frontier — the set of configs you can't improve on one axis without making another worse.",
    long: "Example: config A has higher ROI but bigger drawdown than B. Both can be on the frontier. The frontier is the menu of trade-offs to choose from.",
    learnMoreHref: "/docs/alphasearch.md#pareto",
  },
  composite_score: {
    short:
      "A single number combining ROI, sample size, drawdown, and overfit penalties.",
    long: "Higher is better. The optimizer maximizes this. Surfaces the 'overall best' but the Pareto frontier is more honest about trade-offs.",
    learnMoreHref: "/docs/alphasearch.md#composite-score",
  },

  // ── Overfit corrections ────────────────────────────────────────────────
  dsr: {
    short:
      "Deflated Sharpe Ratio — Sharpe discounted by how many configurations you trialed.",
    long: "The more trials, the more luck looks like skill. DSR accounts for this. DSR > 0.95 is roughly 'unlikely to be a fluke'.",
    learnMoreHref: "/docs/alphasearch.md#dsr",
  },
  psr: {
    short:
      "Probabilistic Sharpe Ratio — probability your true Sharpe beats a benchmark.",
    long: "PSR > 0.95 ≈ statistically significant at the 5% level.",
    learnMoreHref: "/docs/alphasearch.md#psr",
  },
  pbo: {
    short:
      "Probability of Backtest Overfitting — how likely it is that your 'best' config was just lucky.",
    long: "Bailey & López de Prado's PBO test. Lower is better. PBO < 5% is excellent; PBO > 30% means the search space is too aggressive for your data.",
    learnMoreHref: "/docs/alphasearch.md#pbo",
  },
  wrc: {
    short:
      "White's Reality Check — tests whether the best strategy beats a baseline by more than chance.",
    long: "Returns a p-value. < 0.05 means the best config likely contains real signal vs the baseline.",
    learnMoreHref: "/docs/alphasearch.md#wrc",
  },

  // ── Sizing ─────────────────────────────────────────────────────────────
  kelly_fraction: {
    short:
      "Kelly fraction — what fraction of full Kelly to bet (0.25 = quarter Kelly).",
    long: "Full Kelly maximizes long-run growth but causes 50%+ drawdowns. Quarter Kelly is the empirical sweet spot used by most professionals.",
    learnMoreHref: "/docs/alphasearch.md#kelly-fraction",
  },
  kelly_cap_pct: {
    short:
      "Maximum % of bankroll any single bet can risk, regardless of Kelly's recommendation.",
    long: "Acts as a circuit breaker — if Kelly says 25% but cap is 5%, we bet 5%.",
  },
  staking_scheme: {
    short: "How stakes are sized per bet.",
    long: "flat = same stake every bet · kelly = standard Kelly · sqrt-kelly = √(kelly), gentler · log-utility = risk-averse approximation.",
  },

  // ── Search algorithms ──────────────────────────────────────────────────
  random_search: {
    short:
      "Random Search — samples configurations uniformly from the search space.",
    long: "Think of it as throwing darts at the board. Every spot is equally likely. Surprisingly hard to beat when you only have time for a few hundred trials. Use it as a baseline to check that fancier methods actually help.",
  },
  tpe: {
    short:
      "TPE — Bayesian sampler that learns where good configs cluster, then focuses there.",
    long: "Imagine searching for the best seat in a cinema: the first few trials are random, but once TPE sees which rows had good views it keeps picking seats nearby. Converges 5-10× faster than random in high-dim spaces. Optuna's default sampler.",
    learnMoreHref: "/docs/alphasearch.md#tpe",
  },
  nsga2: {
    short:
      "NSGA-II — multi-objective optimizer; returns the full Pareto frontier instead of one winner.",
    long: "Use it when you want to compare trade-offs: e.g. 'show me the configs with the highest ROI for each drawdown budget'. Slower than TPE because it has to explore the whole frontier, not just one peak.",
    learnMoreHref: "/docs/alphasearch.md#nsga2",
  },
  ensemble: {
    short:
      "Ensemble — runs random + TPE together, picks the winner. Best default for most runs.",
    long: "You get unbiased coverage from random AND focused refinement from TPE without having to choose. For a weekly production sweep on ~1k bets this is almost always what you want.",
    learnMoreHref: "/docs/alphasearch.md#ensemble",
  },
  ml_xgboost: {
    short:
      "Trains an XGBoost classifier per CV fold and bets when its calibrated probability exceeds a threshold.",
    long: "Optuna sweeps XGBoost hyperparams (n_estimators, max_depth, learning rate) + the decision threshold + Kelly sizing. Same CPCV harness as the rule-based path so DSR/PBO/Pareto are comparable apples-to-apples.",
    learnMoreHref: "/docs/alphasearch.md#ml-xgboost",
  },

  // ── Status + lifecycle ────────────────────────────────────────────────
  trial: {
    short: "One candidate strategy — the optimizer tries it out on your data.",
    long: "Each trial is a complete recipe: 'EV ≥ 3%, max odds 4.0, Kelly fraction 0.25, …'. The optimizer scores each recipe on every CV fold and keeps the best ones. 2,000 trials ≈ 2,000 different recipes tried.",
  },
  search_space: {
    short:
      "The menu of knobs the optimizer is allowed to turn, and how far each one goes.",
    long: "Example: 'EV cutoff between 1% and 5%, Kelly fraction between 0.1 and 0.5, minimum odds age between 30s and 300s'. Bigger menu = more ground to cover but higher risk of fitting to noise. 11 dimensions by default.",
  },
  data_scope: {
    short:
      "Which historical bets enter the analysis at all — applied BEFORE the optimizer searches.",
    long: "Different from the search-space dimensions, which sweep configurations within the included data. Use data scope to say 'exclude all NineWickets-Exchange bets' or 'only analyze bets from the last 90 days'. Default = include every settled bet.",
    learnMoreHref: "/docs/alphasearch.md#data-scope",
  },
  schedule_frequency: {
    short:
      "How often a schedule fires — preset choices: every N hours, daily at a time, or weekly on a day.",
    long: "Phase 2 uses a preset list rather than free-form cron strings, so the picker is honest for non-technical operators. Each fire creates a fresh run on the latest bet data. 'Run now' on any schedule manually fires once without affecting the next scheduled time.",
    learnMoreHref: "/docs/alphasearch.md#schedules",
  },
  strategy: {
    short:
      "A configuration promoted from a trial to live use — claims matching value bets in real time.",
    long: "Strategies have status: candidate → live → paused → retired. Live strategies are consulted by the value detector on every detection tick — matching bets are tagged with the strategy id so live performance is tracked separately and compared to the OOS estimate.",
    learnMoreHref: "/docs/alphasearch.md#strategies",
  },
  strategy_drift: {
    short:
      "Live ROI has fallen outside the strategy's OOS confidence interval — the edge may have decayed.",
    long: "Comparing live since-promotion ROI vs the OOS bootstrap CI captured at promotion time. Outside the band = either the market has tightened around your edge, or the strategy was overfit to begin with. Investigate or pause.",
    learnMoreHref: "/docs/alphasearch.md#drift",
  },
  auto_validation: {
    short:
      "Weekly automated drift check. Three consecutive flagged checks → auto-pause.",
    long: "Once every 7 days the auto-validator re-evaluates each live strategy. If live ROI is outside the OOS confidence band AND the strategy has ≥50 settled bets, the check is flagged. Three consecutive flagged checks (~3 weeks) auto-pause the strategy and write a note explaining why. Resume manually after investigating.",
    learnMoreHref: "/docs/alphasearch.md#auto-validation",
  },
} satisfies Record<string, GlossaryEntry>;

export function getTerm(id: TermId): GlossaryEntry {
  return GLOSSARY[id];
}
