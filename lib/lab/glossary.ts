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
      "Combinatorial Purged Cross-Validation — splits your bets into time-respecting train/test groups.",
    long: "From 10 groups with 2 test groups, CPCV produces 45 out-of-sample paths (vs 3-5 with simple walk-forward). More OOS paths = more reliable result. From López de Prado's 'Advances in Financial Machine Learning'.",
    learnMoreHref: "/docs/alphasearch.md#cpcv",
  },
  walkforward: {
    short:
      "Walk-Forward Analysis — train on a window, test on the next window, slide forward.",
    long: "The classic time-series CV. Simpler than CPCV but produces fewer OOS estimates. Good for sanity-checking CPCV results.",
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
    long: "Provably better than grid search above 5 dimensions (Bergstra & Bengio 2012). Gives unbiased coverage as a baseline.",
  },
  tpe: {
    short:
      "Tree-Structured Parzen Estimator — Bayesian optimizer that learns where good configs cluster.",
    long: "Converges 5-10× faster than random in high-dim spaces. Optuna's default sampler.",
    learnMoreHref: "/docs/alphasearch.md#tpe",
  },
  nsga2: {
    short:
      "NSGA-II — multi-objective genetic algorithm; returns the Pareto frontier directly.",
    long: "Best when you have multiple competing objectives (ROI vs drawdown). Phase 2.",
    learnMoreHref: "/docs/alphasearch.md#nsga2",
  },
  ensemble: {
    short:
      "Runs random + TPE (+ NSGA-II) under one study — best of all worlds.",
    long: "Random gives baseline coverage; TPE refines; NSGA-II finds the frontier. The recommended default.",
    learnMoreHref: "/docs/alphasearch.md#ensemble",
  },

  // ── Status + lifecycle ────────────────────────────────────────────────
  trial: {
    short: "One sampled configuration evaluated across every CV fold.",
  },
  search_space: {
    short:
      "The set of dimensions you let the optimizer tune, with bounds for each.",
    long: "Bigger = more exploration but more overfitting risk. Default is 11 dimensions; you can disable any of them per run.",
  },
  data_scope: {
    short:
      "Which historical bets enter the analysis at all — applied BEFORE the optimizer searches.",
    long: "Different from the search-space dimensions, which sweep configurations within the included data. Use data scope to say 'exclude all NineWickets-Exchange bets' or 'only analyze bets from the last 90 days'. Default = include every settled bet.",
    learnMoreHref: "/docs/alphasearch.md#data-scope",
  },
  strategy: {
    short:
      "A configuration promoted from a trial to live use — claims matching value bets in real time.",
    long: "Strategies have status: candidate → live → paused → retired. Phase 3.",
  },
} satisfies Record<string, GlossaryEntry>;

export function getTerm(id: TermId): GlossaryEntry {
  return GLOSSARY[id];
}
