/**
 * Single-source-of-truth registry of technical terms shown in the Lab UI.
 *
 * Every `<TermTooltip>` reads from this map.
 *
 * Voice (CLAUDE.md → "Explanatory copy"):
 *   short:     one-line plain-English headline. NO acronyms, NO jargon
 *              (no "OOS", no "Sharpe ratio", no "Bayesian sampler").
 *   example:   ONE flowing paragraph that explains how the thing works
 *              AND illustrates it with a concrete betting scenario in
 *              the same breath — real-looking numbers, this app's
 *              providers (Pinnacle, NineWickets-Exchange, NineWickets-SB),
 *              real markets (1X2, Asian Handicap, BTTS, O/U), real bet
 *              counts (e.g. "1,200 settled bets"). Don't separate the
 *              "definition" from the "example" — weave them together.
 *   objective: ONLY for choice-type entries (algorithms, CV mode,
 *              staking scheme, Kelly fraction). One short italic
 *              sentence that answers "why pick this one?". Skip
 *              entirely for metric/concept entries.
 *   long:      DEPRECATED. The field is kept on the type for backwards
 *              compatibility but is no longer rendered. Leave it unset
 *              on every entry.
 */

export interface GlossaryEntry {
  /** One-line plain-English headline. */
  short: string;
  /** @deprecated No longer rendered. Do not use on new entries. */
  long?: string;
  /**
   * Plain-English explanation woven together with a concrete betting
   * illustration. One paragraph. Uses real provider/market names from
   * this app and real-looking numbers (BDT amounts, bet counts, ROI %).
   */
  example?: string;
  /**
   * One short sentence answering "why pick this one?". Only set on
   * choice-type entries (algorithms, CV mode, staking scheme, Kelly
   * fraction). Skip for metric/concept entries.
   */
  objective?: string;
}

export type TermId = keyof typeof GLOSSARY;

export const GLOSSARY = {
  // ── Performance metrics ──────────────────────────────────────────────
  roi: {
    short: "Return on investment — how much you ended up ahead, in percent.",
    example:
      "Across 820 settled bets you staked 100,000 BDT total and finished at +4,250 BDT. That's an ROI of 4.25%. The number alone can mislead on a small sample — always look at the believable range next to it. If 'somewhere between 1.8% and 6.7%' you have a real edge; if 'somewhere between −1.2% and 9.1%' you don't know yet, you just need more bets.",
  },
  clv: {
    short:
      "Closing Line Value — how much better your odds were than the market's final odds.",
    example:
      "You backed Liverpool at NineWickets-Exchange on 2.10. By kick-off, Pinnacle's price on the same outcome had drifted to 1.95. Your CLV on that bet is +7.7% — the sharpest book in the world moved toward your side, which is what genuine edge looks like. CLV is the fastest signal that you're picking real value: ROI needs thousands of bets to settle down, CLV stabilises after about 50.",
  },
  sharpe: {
    short: "Sharpe ratio — return adjusted for how bumpy the equity curve is.",
    example:
      "Strategy A makes 4% ROI with smooth, steady growth → Sharpe ≈ 1.33. Strategy B makes the same 4% but with wild 15-bet losing streaks → Sharpe ≈ 0.50. Same headline ROI, very different ride. The higher-Sharpe strategy is the one you'll actually keep running because you won't panic-stop during a bad week.",
  },
  sortino: {
    short:
      "Sortino ratio — like Sharpe, but only counts the bumpy parts that lose money.",
    example:
      "Two configs both make 5% ROI. Config X has big winning streaks and small losing streaks → high Sortino. Config Y has small winning streaks and occasional 10-bet losing ruts → low Sortino. Sortino is more honest than Sharpe for betting because it doesn't punish you for upside swings — only for the drawdowns that actually hurt your bankroll.",
    objective:
      "Prefer Sortino over Sharpe when picking a strategy to take live — it tracks the pain you'd actually feel.",
  },
  drawdown: {
    short:
      "Max drawdown — the biggest peak-to-trough loss the strategy ever had.",
    example:
      "Your bankroll climbs from 100k BDT to 135k, then a 22-bet losing streak drags it down to 98k before recovering. The biggest fall from peak was (135 − 98) / 135 ≈ 27%. That's a normal range for quarter-Kelly sizing. Full Kelly on the same bets would have been 50%+ — survivable on paper but the kind of fall that makes you pull the plug at the wrong moment.",
  },
  sample_size: {
    short: "How many of your bets survived this configuration's filters.",
    example:
      "Config A demands EV ≥ 5% AND odds ≤ 3.0 — only 47 of your 1,200 settled bets pass. Even if those 47 show 12% ROI, the believable range is roughly −3% to +27% — basically no signal. Config B uses EV ≥ 2% and keeps 780 bets at 4.8% ROI with a believable range of 3.1% to 6.5%. Less flashy, way more trustworthy. Trials with fewer than 50 surviving bets get flagged as low confidence and shouldn't go live.",
  },
  win_rate: {
    short: "What percentage of your decisive bets won.",
    example:
      "Your Asian Handicap strategy wins 42% of bets but each winner pays around 2.35 odds — so you make money even though you lose more often than you win. A lower-odds moneyline strategy might win 65% of bets and barely break even. Win rate alone tells you almost nothing — always read it next to the average odds.",
  },

  // ── CV + bootstrap ─────────────────────────────────────────────────────
  cpcv: {
    short: "Tests each strategy on bets it has never seen, many times over.",
    example:
      "Imagine grading a student by hiding 2 chapters out of 10, teaching on the other 8, then testing on the hidden ones — and repeating that for every possible pair of hidden chapters. That's 45 mini-exams per strategy. On your 1,200 settled bets, we hide 240 at a time, train on the remaining 960, and check if your filter still makes money. A strategy that wins on 40 of 45 tries is genuinely good; one that wins on 25 is mostly luck.",
    objective:
      "The default — use it unless you specifically need the next option's strict time order.",
  },
  walkforward: {
    short:
      "Trains on older bets, tests on newer ones, and slides the window forward in time.",
    example:
      "Train on January–June bets, test on July. Then January–July, test on August. Then January–August → September. Six tests instead of CPCV's 45 — but every single one mimics 'you've never seen the future', which is exactly what live betting feels like.",
    objective:
      "Pick this if you want a real-time deployment dress rehearsal. If your CPCV winner falls apart here, the edge is shakier than it looked.",
  },
  embargo: {
    short:
      "How many bets we drop near the boundary between training and testing data.",
    example:
      "On a Premier League weekend, your Saturday Liverpool bet and your Sunday Man City bet might both be tagged by the same injury news. Without embargo, the model 'sees' Saturday's outcome and uses it to predict Sunday — impossible in real life. Dropping the 5–10 bets around each boundary stops that kind of leak. Increase it for markets with heavy news correlation (e.g. cricket series).",
  },
  bootstrap: {
    short:
      "We shuffle your bet history thousands of times to build a believable range around each number.",
    example:
      "Your trial scores 4.8% ROI. We resample your 780 bets a thousand times in different orders and re-compute ROI each time. Result: a believable range of 3.1% to 6.5%. A narrow range means trust the number; a wide one means you need more bets. Always promote on the low end of this range, not the headline number.",
  },
  ci: {
    short: "The believable range your true number probably sits in.",
    example:
      "Trial A: 5.2% ROI, believable range 3.9% to 6.5% (340 bets). Trial B: 9.1% ROI, believable range −2.8% to 21% (48 bets). Trial B's headline looks better, but its range crosses zero — it could easily be losing money. Trial A is the safer pick. Always rank by the low end of the range, not by the headline.",
  },

  // ── Multi-objective + Pareto ───────────────────────────────────────────
  pareto: {
    short:
      "The trade-off line — configs you can't improve on one axis without giving up something on another.",
    example:
      "Config A: 7.8% ROI but 22% biggest fall. Config B: 5.2% ROI with only 9% biggest fall. Config C: 6.1% ROI with 14% biggest fall. All three sit on the trade-off line because none clearly beats the others — you choose based on 'can I stomach a 22% drawdown for the extra 2.6% ROI?'. There's no single 'best' here; it's a menu.",
  },
  composite_score: {
    short:
      "A single number that combines ROI, sample size, drawdown, and overfit risk.",
    example:
      "A trial with 5% ROI / 700 bets / 12% drawdown / clean overfit checks scores higher than a trial with 8% ROI / 55 bets / 35% drawdown / weak overfit checks. The headline ROI of the second trial looks better, but the score rewards the first one's bigger sample, smaller drawdown, and stronger statistical backing. Sort by this score to surface the optimiser's overall best pick.",
  },

  // ── Overfit corrections ────────────────────────────────────────────────
  dsr: {
    short:
      "How likely the winning strategy is real skill rather than pure luck.",
    example:
      "If you tested 2,000 strategies, even random ones will throw up some impressive-looking winners — that's just statistics. This score discounts the headline performance by how many strategies you tried: the more you tried, the more the winner has to prove itself. Above 0.95 means the winner is very probably real. Below 0.7 means you searched so hard you were almost guaranteed to find a lucky-looking one.",
  },
  psr: {
    short:
      "How likely the winning strategy's smoothness is genuine, not a fluke.",
    example:
      "Your trial looks impressively smooth across 600 bets. This score asks: 'how likely is that smoothness real, given the sample size?' A score of 0.98 means 98% confident the underlying behaviour is genuinely smooth, not lucky variance. Promote only when this is above 0.95 — below that, the smoothness is statistically indistinguishable from random.",
  },
  pbo: {
    short:
      "How likely your 'best' configuration was just lucky rather than genuinely good.",
    example:
      "Your run scores 4% here — the best configuration ranks in the top half of fresh tests 96% of the time, which is strong evidence it's real. A score of 42% would mean your best is basically a coin-flip on new data — you searched too hard. Below 5% is excellent; above 30% means narrow your search or collect more bets before the next run.",
  },
  wrc: {
    short:
      "How likely the winning strategy beats a 'bet on everything' baseline by more than chance.",
    example:
      "Your winning configuration beats the baseline of 'bet flat on every detected value bet' with a score of 0.02 — only a 2% chance the difference is random. A score of 0.31 would mean the winner isn't really beating a dumb fallback. Below 0.05 is the cross-check you want before promoting anything live.",
  },

  // ── Sizing ─────────────────────────────────────────────────────────────
  kelly_fraction: {
    short:
      "How much of full Kelly to bet (0.25 means a quarter of what Kelly suggests).",
    example:
      "Full Kelly on a +3% EV bet at 2.0 odds tells you to stake 3% of bankroll. Quarter Kelly stakes 0.75%. On a 100k BDT bankroll that's 3,000 vs 750 BDT per bet — the quarter version grows slower but survives a 20-bet losing streak. The full version risks a 50% drawdown that's mathematically fine but emotionally devastating.",
    objective:
      "0.10 is conservative (small steady growth, tiny falls). 0.25 is the sweet spot most pros use. 0.50 grows fastest but expect 30%+ falls.",
  },
  kelly_cap_pct: {
    short:
      "The maximum % of bankroll any single bet can risk, no matter what Kelly says.",
    example:
      "Kelly recommends 8% on a rare +12% EV bet at 5.0 odds. Your cap is 3%. You bet 3% instead. You leave some theoretical growth on the table — but if that bet loses, you lose 3% of bankroll, not 8%. The cap protects you from outlier EV spikes caused by stale prices, bad data, or model mis-calibration. 2–5% is standard; never go above 10%.",
  },
  staking_scheme: {
    short: "How each bet's stake is sized.",
    example:
      "On the same 800-bet history: flat 200 BDT every bet might give 4.8% ROI. Quarter-Kelly (varying stake) might give 6.1% with similar drawdowns. Square-root-Kelly might give 5.5% with smaller drawdowns. Each scheme trades off growth, drawdown protection, and simplicity differently.",
    objective:
      "Flat = simplest, no surprises. Kelly = highest growth in theory. Sqrt-Kelly = Kelly's growth with half the pain. Log-utility = puts survival above expected growth.",
  },

  // ── Search algorithms ──────────────────────────────────────────────────
  random_search: {
    short:
      "Tries combinations evenly across the full menu of knobs, with no pattern.",
    example:
      "With 2,000 trials, it might pick 'min EV 1.8% + Kelly 0.30 + max odds 6.5', then 'min EV 4.2% + Kelly 0.15 + max odds 2.8', then 'min EV 2.7% + Kelly 0.40 + sportsbook only', and so on — broad coverage of the whole space. Surprisingly hard to beat when you only have a few hundred trials.",
    objective:
      "The honest baseline. If a fancier method can't beat random's best, the fancier method isn't adding value — save the compute.",
  },
  tpe: {
    short: "Learns from the early trials and focuses on what looks promising.",
    example:
      "After 80 random trials, this method notices your highest ROIs cluster around 'min EV ≈ 2.5% + Kelly ≈ 0.22 + Asian Handicap'. It then spends the remaining trials refining that corner — testing nearby Kelly values and EV cutoffs — instead of wandering the full space. Converges 5–10× faster than random when the search has many knobs.",
    objective:
      "Pick this when you want one well-refined winner to promote, not a menu of trade-offs.",
  },
  nsga2: {
    short: "Maps the full trade-off line instead of returning a single winner.",
    example:
      "Instead of one 'best' config, you get a menu: '7.8% ROI / 22% biggest fall', '5.2% ROI / 9% biggest fall', '6.1% ROI / 14% biggest fall', '4.0% ROI / 5% biggest fall' — each one optimal for its own risk budget.",
    objective:
      "Pick this when you want to compare trade-offs. Ideal for 'show me the best ROI at every drawdown budget' or 'max ROI, but no more than 15% drawdown'.",
  },
  ensemble: {
    short: "Runs two search strategies side-by-side and picks the best result.",
    example:
      "One method throws darts everywhere on the menu so it doesn't miss promising regions. The other watches the early scores and zooms in on what's working. Together you get broad coverage AND focused refinement — without having to choose between them. On a typical weekly sweep of 1,200 settled bets it'll find a config 10–20% better than either method alone.",
    objective:
      "The safe production default — pick this if you're not sure which to use.",
  },
  ml_xgboost: {
    short:
      "Lets a learning model find the edges instead of you writing filter rules.",
    example:
      "Instead of saying 'bet only when EV ≥ 3% and odds ≤ 4.0', the model digs through your settled bets and might learn 'BTTS at NineWickets-SB with sharp probability between 0.55 and 0.65 and EV > 3% wins 58% of the time' — a three-way pattern hand-written rules would never spot. It bets every situation that matches, sized by the trial's Kelly settings.",
    objective:
      "Use this when you've maxed out rule-based filters and want to find non-obvious patterns. Needs 2,000+ settled bets to be reliable. Harder to defend ('trust this model' vs 'trust EV ≥ 3%'), so try rule-based first.",
  },

  // ── Status + lifecycle ────────────────────────────────────────────────
  trial: {
    short: "One candidate strategy — the optimiser tries it on your bets.",
    example:
      "A single trial is a complete recipe like 'min EV 2.7% + Kelly 0.25 + max odds 4.0 + only 1X2 and O/U 2.5 + only NineWickets-Exchange and NineWickets-SB + embargo 5'. Running 2,000 trials means scoring 2,000 such recipes against your 1,200 settled bets, across 45 hidden-data tests each — that's 90,000 mini-backtests in total.",
  },
  search_space: {
    short:
      "The menu of knobs the optimiser can turn, and how far each one goes.",
    example:
      "Default menu: min EV between 1.0% and 5.0%, Kelly between 0.10 and 0.50, max odds between 1.5 and 10.0, any subset of markets (1X2, O/U 2.5, Asian Handicap, BTTS), any subset of soft books, plus six more knobs. A wider menu covers more ground but increases the risk of fitting to noise. Narrow any range when you have prior reason to trust it.",
  },
  data_scope: {
    short:
      "Which historical bets enter the analysis at all — applied before the search starts.",
    example:
      "Set scope to 'only bets from the last 180 days, only NineWickets-Exchange and NineWickets-SB, only 1X2 and Asian Handicap'. Out of 2,100 total bets, 860 enter the run. The optimiser then searches within those 860 — BetConstruct bets simply don't exist for this run, even on the trade-off line. Use this when you distrust a provider, market, or era; use the search-space menu instead if you want the optimiser to discover whether a provider helps.",
  },
  schedule_frequency: {
    short:
      "How often a schedule fires — every N hours, daily at a time, or weekly on a day.",
    example:
      "Common setups: 'Daily at 03:00 Asia/Dhaka' for a drift check after overnight bets settle. 'Weekly on Sunday at 06:00' for a deep 10,000-trial sweep on the full bet history. 'Every 4 hours' for an active discovery loop on busy betting weekends. You can also click 'Run now' on any schedule to fire a one-off without affecting the next-scheduled time.",
  },
  strategy: {
    short:
      "A configuration promoted from a trial to live — claims matching value bets in real time.",
    example:
      "You promote the trial 'min EV 2.5%, Kelly 0.25, only Asian Handicap, only NineWickets-SB' to a strategy. From then on, any incoming AH bet at NineWickets-SB with EV ≥ 2.5% gets tagged with this strategy. Its live performance is tracked separately and compared to the snapshot captured at promotion time.",
  },
  strategy_drift: {
    short:
      "Live ROI has fallen outside the strategy's expected range — the edge may have decayed.",
    example:
      "Strategy promoted at 5.2% ROI with believable range 3.1% to 6.5%. Three months later, 78 settled bets give 0.8% live ROI — outside the lower end of that range. The drift chip lights up: maybe the soft book has tightened its lines, or the original estimate was too optimistic. Investigate before the next weekend.",
  },
  auto_validation: {
    short:
      "A weekly automated drift check. Three flagged checks in a row → auto-pause.",
    example:
      "Your 'BTTS at NineWickets-SB' strategy passes for six weeks (green dots). Week 7 the live ROI dips below the expected range (amber). Week 8 still amber. Week 9 amber → auto-pause with a note: 'live ROI −1.2% vs expected range 2.8% to 5.1% over 120 settled bets'. You investigate, decide the market tightened, and retire it.",
  },
} satisfies Record<string, GlossaryEntry>;

export function getTerm(id: TermId): GlossaryEntry {
  return GLOSSARY[id];
}
