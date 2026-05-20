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
 *   ranges:    For numeric metrics only. Direction + thresholds used to
 *              render "Your value: X — verdict" when a live value is
 *              passed to TermTooltip. Also provides a static guidanceNote
 *              for column-header tooltips where no specific value exists.
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
  /**
   * Numeric range metadata. When present, TermTooltip shows either a
   * static guidance note (no value prop) or a dynamic "Your value: X"
   * verdict (value prop provided).
   */
  ranges?: GlossaryRanges;
}

// ── Range types ───────────────────────────────────────────────────────────

export type RangeValueFormat = "pct_decimal" | "pct" | "decimal" | "integer";

export interface GlossaryThreshold {
  /**
   * Boundary value.
   * lower_is_better: value ≤ bound → this tier.
   * higher_is_better: value ≥ bound → this tier.
   */
  bound: number;
  tone: "positive" | "warning" | "danger";
  /** Sentence shown in the "Your value: X — verdict" block. */
  verdict: string;
}

export interface GlossaryRanges {
  direction: "lower_is_better" | "higher_is_better";
  /** How to format the raw numeric value in "Your value: X". */
  valueFormat: RangeValueFormat;
  /**
   * Shown in column-header tooltips where no specific value is in scope.
   * One short line: "Higher is better · above 5% = strong, 2–5% = decent…"
   */
  guidanceNote: string;
  /**
   * Sorted best-first:
   *   higher_is_better → descending bounds (check value >= bound from highest)
   *   lower_is_better  → ascending bounds  (check value <= bound from lowest)
   */
  thresholds: GlossaryThreshold[];
  /** Applies when value is beyond every threshold in the bad direction. */
  fallback: { tone: "positive" | "warning" | "danger"; verdict: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────

export type TermId = keyof typeof GLOSSARY;

export const GLOSSARY = {
  // ── Performance metrics ──────────────────────────────────────────────
  roi: {
    short: "Return on investment — how much you ended up ahead, in percent.",
    example:
      "Across 820 settled bets you staked 100,000 BDT total and finished at +4,250 BDT. That's an ROI of 4.25%. The number alone can mislead on a small sample — always look at the believable range next to it. If 'somewhere between 1.8% and 6.7%' you have a real edge; if 'somewhere between −1.2% and 9.1%' you don't know yet, you just need more bets.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "pct",
      guidanceNote:
        "Higher is better · above 5% = strong, 2–5% = decent, 0–2% = marginal, below 0% = losing",
      thresholds: [
        {
          bound: 5.0,
          tone: "positive",
          verdict:
            "Strong. 5%+ ROI on a solid sample is a real signal worth promoting and tracking live.",
        },
        {
          bound: 2.0,
          tone: "warning",
          verdict:
            "Decent. Profitable, but check the CI lower bound before promoting — if it dips below zero, you don't have statistical proof of an edge yet.",
        },
        {
          bound: 0.0,
          tone: "warning",
          verdict:
            "Marginal. Just above zero — the believable range likely straddles zero. More bets or a tighter search needed before this is promotable.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Losing. Below-zero ROI on unseen bets means no edge here, or the filter is pruning too aggressively.",
      },
    },
  },
  clv: {
    short:
      "Closing Line Value — how much better your odds were than the market's final odds.",
    example:
      "You backed Liverpool at NineWickets-Exchange on 2.10. By kick-off, Pinnacle's price on the same outcome had drifted to 1.95. Your CLV on that bet is +7.7% — the sharpest book in the world moved toward your side, which is what genuine edge looks like. CLV is the fastest signal that you're picking real value: ROI needs thousands of bets to settle down, CLV stabilises after about 50.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "pct",
      guidanceNote:
        "Higher is better · above 3% = strong signal, 1–3% = decent, 0–1% = marginal, below 0% = you're getting worse odds than the market",
      thresholds: [
        {
          bound: 3.0,
          tone: "positive",
          verdict:
            "Strong. 3%+ CLV is compelling evidence your picks consistently beat where the market moves — the kind of edge that sustains a long-term strategy.",
        },
        {
          bound: 1.0,
          tone: "warning",
          verdict:
            "Decent. 1–3% CLV is positive but could be noise on a small sample. It needs 100+ bets to stabilise into a reliable signal.",
        },
        {
          bound: 0.0,
          tone: "warning",
          verdict:
            "Marginal. Just above zero — you're roughly in line with where the market closes. Real CLV edge needs to be consistently positive across many bets.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Negative CLV. You're consistently getting worse odds than where the market moves. A filter or provider check may reveal why.",
      },
    },
  },
  sharpe: {
    short: "Sharpe ratio — return adjusted for how bumpy the equity curve is.",
    example:
      "Strategy A makes 4% ROI with smooth, steady growth → Sharpe ≈ 1.33. Strategy B makes the same 4% but with wild 15-bet losing streaks → Sharpe ≈ 0.50. Same headline ROI, very different ride. The higher-Sharpe strategy is the one you'll actually keep running because you won't panic-stop during a bad week.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "decimal",
      guidanceNote:
        "Higher is better · above 1.5 = excellent, 1–1.5 = good, 0.5–1 = marginal, below 0.5 = weak",
      thresholds: [
        {
          bound: 1.5,
          tone: "positive",
          verdict:
            "Excellent equity-curve smoothness — rare in betting and very promotable.",
        },
        {
          bound: 1.0,
          tone: "warning",
          verdict:
            "Good. The curve has some bumps but trends consistently upward.",
        },
        {
          bound: 0.5,
          tone: "warning",
          verdict:
            "Marginal. Real edge, but a bad week will feel severe. Check Sortino to see if upside swings or actual drawdowns drive the bumpiness.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Weak. Below 0.5, choppy periods dominate the growth. Check Sortino to understand where the bumpiness comes from.",
      },
    },
  },
  sortino: {
    short:
      "Sortino ratio — like Sharpe, but only counts the bumpy parts that lose money.",
    example:
      "Two configs both make 5% ROI. Config X has big winning streaks and small losing streaks → high Sortino. Config Y has small winning streaks and occasional 10-bet losing ruts → low Sortino. Sortino is more honest than Sharpe for betting because it doesn't punish you for upside swings — only for the drawdowns that actually hurt your bankroll.",
    objective:
      "Prefer Sortino over Sharpe when picking a strategy to take live — it tracks the pain you'd actually feel.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "decimal",
      guidanceNote:
        "Higher is better · above 2 = excellent, 1–2 = good, 0.5–1 = marginal, below 0.5 = weak",
      thresholds: [
        {
          bound: 2.0,
          tone: "positive",
          verdict:
            "Excellent. The gains comfortably outweigh the losing stretches — this strategy would feel manageable in live operation.",
        },
        {
          bound: 1.0,
          tone: "warning",
          verdict:
            "Good. 1.0–2.0 is solid for a betting strategy. Some rough patches, but net growth is meaningful.",
        },
        {
          bound: 0.5,
          tone: "warning",
          verdict:
            "Marginal. Just above break-even on a risk-adjusted basis. Watch whether live performance holds this ratio.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Weak. Below 0.5, the downswings dominate the growth. The equity curve is too choppy to run with confidence.",
      },
    },
  },
  drawdown: {
    short:
      "Max drawdown — the biggest peak-to-trough loss the strategy ever had.",
    example:
      "Your bankroll climbs from 100k BDT to 135k, then a 22-bet losing streak drags it down to 98k before recovering. The biggest fall from peak was (135 − 98) / 135 ≈ 27%. That's a normal range for quarter-Kelly sizing. Full Kelly on the same bets would have been 50%+ — survivable on paper but the kind of fall that makes you pull the plug at the wrong moment.",
    ranges: {
      direction: "lower_is_better",
      valueFormat: "pct_decimal",
      guidanceNote:
        "Lower is better · under 10% = excellent, 10–25% = normal, 25–40% = high, above 40% = very high",
      thresholds: [
        {
          bound: 0.1,
          tone: "positive",
          verdict:
            "Excellent. Under 10% is the sweet spot for quarter-Kelly — losing streaks sting briefly but recover fast.",
        },
        {
          bound: 0.25,
          tone: "warning",
          verdict:
            "Normal. 10–25% is typical for standard Kelly sizing. You'll feel the dip but can stay in the game.",
        },
        {
          bound: 0.4,
          tone: "warning",
          verdict:
            "High. Most real bankrolls start cracking emotionally in this range. Consider a lower Kelly fraction or tighter market filters.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Very high. Above 40%, most operators quit before the math says they should. Drop the Kelly fraction.",
      },
    },
  },
  sample_size: {
    short: "How many of your bets survived this configuration's filters.",
    example:
      "Config A demands EV ≥ 5% AND odds ≤ 3.0 — only 47 of your 1,200 settled bets pass. Even if those 47 show 12% ROI, the believable range is roughly −3% to +27% — basically no signal. Config B uses EV ≥ 2% and keeps 780 bets at 4.8% ROI with a believable range of 3.1% to 6.5%. Less flashy, way more trustworthy. Trials with fewer than 50 surviving bets get flagged as low confidence and shouldn't go live.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "integer",
      guidanceNote:
        "Higher is better · 300+ = reliable, 100–300 = adequate, 50–100 = low, below 50 = too small to trust",
      thresholds: [
        {
          bound: 300,
          tone: "positive",
          verdict:
            "Reliable. 300+ bets gives narrow believable ranges and real statistical power — the numbers mean something here.",
        },
        {
          bound: 100,
          tone: "warning",
          verdict:
            "Adequate. 100–300 bets is workable, but the believable range is still fairly wide. The ROI direction is more reliable than the exact figure.",
        },
        {
          bound: 50,
          tone: "warning",
          verdict:
            "Low. 50–100 bets — treat the ROI as a rough direction, not a firm number. Widen the EV cutoff to capture more bets.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Too small. Under 50 bets is effectively noise — even a 12% ROI could be pure luck. Collect more bets or widen filters.",
      },
    },
  },
  win_rate: {
    short: "What percentage of your decisive bets won.",
    example:
      "Your Asian Handicap strategy wins 42% of bets but each winner pays around 2.35 odds — so you make money even though you lose more often than you win. A lower-odds moneyline strategy might win 65% of bets and barely break even. Win rate alone tells you almost nothing — always read it next to the average odds.",
  },

  // ── ML pipeline terms ─────────────────────────────────────────────────
  ml_score: {
    short:
      "The model's read on whether a new value bet resembles past winners.",
    example:
      "A NineWickets-Exchange 1X2 bet might score 0.78 because its EV is strong, Pinnacle is moving toward the same side, and similar historical bets closed well. Another bet at 0.24 may still pass the raw EV rule, but it looks like past losers, so the model can keep it in shadow, skip it, or reduce the stake depending on permission.",
  },
  training_examples: {
    short:
      "Settled historical bets with features and outcomes that teach the model.",
    example:
      "When a detected Pinnacle-vs-NineWickets value bet settles, its 25 market features and final result become a training example. A won or strong closing-line bet teaches the model what good looked like; a lost or weak-closing bet teaches it what to avoid next time.",
  },
  feature_schema: {
    short:
      "The agreed list and order of numbers that describe each bet to the model.",
    example:
      "If TypeScript writes 25 features but Python trains on a different order, 'soft odds age' could be read as 'provider count' and the model becomes nonsense. The schema check confirms every stored bet uses the current version, count, and feature-name hash before training or scoring.",
  },
  model_validation: {
    short:
      "The safety check that decides whether a trained model is trustworthy enough to deploy.",
    example:
      "A model can look profitable on the data it trained on but fail when tested on bets it has never seen. Validation checks ranking quality, smoothness of returns, calibration, and score buckets before allowing a model to affect NineWickets or Velki staking.",
  },
  deployment_gate: {
    short:
      "The safety lock that controls how much authority ML has over real bets.",
    example:
      "A new model may start in shadow mode, where it only logs what it would have done. After enough evidence, the gate can allow it to skip bets whose model EV is not positive, then reduce weak stakes, and only later increase strong stakes. The old deterministic EV rule remains the fallback when the gate is closed.",
  },
  shadow_mode: {
    short:
      "A dry run where ML records decisions but does not change real placement.",
    example:
      "The normal strategy might place 1,000 BDT on a NineWickets bet while shadow mode records that ML would have staked 500 BDT. After settlement, the Shadow A/B tab compares the normal result against the ML-adjusted result without risking a single extra taka.",
  },
  score_bucket: {
    short:
      "A group of bets with similar ML scores, used to check whether high scores really perform better.",
    example:
      "If bets scored 0.70–0.80 have better CLV and win rate than bets scored 0.30–0.40, the model is ranking risk properly. If the buckets are upside down, a 0.80 score should not be trusted for real-money staking yet.",
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
    ranges: {
      direction: "higher_is_better",
      valueFormat: "decimal",
      guidanceNote:
        "Higher is better · above 0.95 = strong, 0.70–0.95 = borderline, below 0.70 = unreliable",
      thresholds: [
        {
          bound: 0.95,
          tone: "positive",
          verdict:
            "Strong. 95%+ confidence the Sharpe came from real skill, not from testing 2,000 strategies until one looked lucky.",
        },
        {
          bound: 0.7,
          tone: "warning",
          verdict:
            "Borderline. Some signal but not enough confidence to promote. Run more trials or narrow the search space.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Unreliable. Below 0.70, the Sharpe ratio is too likely a lucky fluke from a large search. Don't promote on this alone.",
      },
    },
  },
  psr: {
    short:
      "How likely the winning strategy's smoothness is genuine, not a fluke.",
    example:
      "Your trial looks impressively smooth across 600 bets. This score asks: 'how likely is that smoothness real, given the sample size?' A score of 0.98 means 98% confident the underlying behaviour is genuinely smooth, not lucky variance. Promote only when this is above 0.95 — below that, the smoothness is statistically indistinguishable from random.",
    ranges: {
      direction: "higher_is_better",
      valueFormat: "decimal",
      guidanceNote:
        "Higher is better · above 0.95 = strong, 0.70–0.95 = borderline, below 0.70 = weak",
      thresholds: [
        {
          bound: 0.95,
          tone: "positive",
          verdict:
            "Strong. 95%+ chance the smooth equity curve is real, not an artifact of sample size.",
        },
        {
          bound: 0.7,
          tone: "warning",
          verdict:
            "Borderline. Plausible signal but you need more bets or a more targeted search to trust it.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "Weak. Below 0.70, the smoothness you're seeing is statistically indistinguishable from random luck.",
      },
    },
  },
  pbo: {
    short:
      "How likely your 'best' configuration was just lucky rather than genuinely good.",
    example:
      "Your run scores 4% here — the best configuration ranks in the top half of fresh tests 96% of the time, which is strong evidence it's real. A score of 42% would mean your best is basically a coin-flip on new data — you searched too hard. Below 5% is excellent; above 30% means narrow your search or collect more bets before the next run.",
    ranges: {
      direction: "lower_is_better",
      valueFormat: "pct_decimal",
      guidanceNote:
        "Lower is better · under 5% = excellent, 5–20% = borderline, above 20% = high overfit risk",
      thresholds: [
        {
          bound: 0.05,
          tone: "positive",
          verdict:
            "Excellent. Under 5% probability the winner just got lucky — the edge holds up well across different slices of your bet history.",
        },
        {
          bound: 0.2,
          tone: "warning",
          verdict:
            "Borderline. 5–20% chance the winner is a fluke. Watch live performance carefully for the first 100 bets.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "High overfit risk. Above 20%, there's a real chance you searched until a lucky strategy appeared. Narrow the search space or collect more bets.",
      },
    },
  },
  wrc: {
    short:
      "How likely the winning strategy beats a 'bet on everything' baseline by more than chance.",
    example:
      "Your winning configuration beats the baseline of 'bet flat on every detected value bet' with a score of 0.02 — only a 2% chance the difference is random. A score of 0.31 would mean the winner isn't really beating a dumb fallback. Below 0.05 is the cross-check you want before promoting anything live.",
    ranges: {
      direction: "lower_is_better",
      valueFormat: "decimal",
      guidanceNote:
        "Lower is better · under 0.05 = beats baseline clearly, 0.05–0.20 = borderline, above 0.20 = no clear edge over 'bet everything'",
      thresholds: [
        {
          bound: 0.05,
          tone: "positive",
          verdict:
            "Beats the baseline clearly. Under 5% chance the winner's edge over 'bet everything flat' is random — genuine filtering value confirmed.",
        },
        {
          bound: 0.2,
          tone: "warning",
          verdict:
            "Slim margin. 5–20% — looks better than the baseline, but not conclusively. Run a longer search before promoting.",
        },
      ],
      fallback: {
        tone: "danger",
        verdict:
          "No clear edge. Above 20%, the winner doesn't clearly beat 'bet flat on every detected value bet'. Not ready to promote.",
      },
    },
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

  // ── Paper Trading & ML stake terminology ──────────────────────────────
  paper_trading: {
    short:
      "A dry run that compares the configured baseline stake with the model-adjusted stake on the same real bets — no extra money risked.",
    example:
      "NineWickets-SB Asian Handicap at 1.92. Baseline stakes 1,000 BDT, model stakes 1,400 BDT (×1.40). Bet wins → Baseline PnL = +920 BDT, Model PnL = +1,288 BDT → PnL Delta = +368 BDT. Across 320 settled bets: baseline +2.1% ROI, model +3.4% ROI → Model Lift = +1.3 pts. Promote model authority only after the lift is positive over hundreds of bets.",
  },
  baseline_stake: {
    short:
      "baseline = min(fullKelly × kellyFraction, kellyCap)",
    example:
      "Bankroll 100,000 BDT. Bet at 2.00 odds with +3% EV → fullKelly = 0.03. With kellyFraction = 0.25 and kellyCap = 5%: baseline = min(0.03 × 0.25, 0.05) = 0.0075 → wager 750 BDT. This is exactly what auto-placement wagers when the model has no authority.",
  },
  model_stake_fraction: {
    short:
      "modelFraction = min(baseline × multiplier, 2 × baseline)",
    example:
      "baseline = 0.75% (750 BDT), multiplier = ×1.40 → modelFraction = min(0.75% × 1.40, 1.50%) = 1.05% → wager 1,050 BDT. The 2× cap blocks a runaway multiplier from blowing up a single position.",
  },
  model_stake_multiplier: {
    short:
      "Skip if × < 0.10 · Shrink if 0.10 ≤ × < 0.95 · Agree if 0.95 ≤ × ≤ 1.05 · Boost if × > 1.05",
    example:
      "NineWickets-Exchange BTTS, score = 0.78, sharp steam confirms direction, persistence = 14 ticks → × = 1.46 (Boost). 1X2 bet, score = 0.18, convergence_rate < 0 → × = 0.05 (Skip). Computed from the 25-feature vector at detection time, not from the score alone.",
  },
  pnl_delta: {
    short:
      "PnL Delta = Model PnL − Baseline PnL.  Positive ⇒ model would have done better.",
    example:
      "Stakes: baseline 750, model 1,050 BDT. Bet wins at 1.92 → Baseline PnL = 750 × 0.92 = +690, Model PnL = 1,050 × 0.92 = +966, Delta = +276 BDT. Same stakes on a losing bet → Delta = −1,050 − (−750) = −300 BDT. Summed across hundreds of settled bets, the running PnL Delta is the headline 'is the model worth it' number.",
  },
  model_lift: {
    short:
      "Model Lift = Model Gate ROI − Simple EV Rule ROI  (percentage points over the same period).",
    example:
      "Last 30 days, same bets: Simple EV Rule +2.8% ROI, Model Gate +4.1% ROI → Lift = +1.3 pts. Consistently positive over a 200+ bet sample ⇒ escalate the model's permission. Flat or negative ⇒ the model isn't earning its complexity.",
  },
  model_stance: {
    short:
      "Multiplier band: Skip · Shrink · Agree · Boost.",
    example:
      "Skip (× < 0.10): don't bet. Shrink (0.10–0.95): real edge, smaller than the rule thinks. Agree (0.95–1.05): nothing to add. Boost (> 1.05): bet is stronger than the rule reflects. Four bands let you scan a table and instantly see where rule and model diverge.",
  },
  detection_baseline: {
    short:
      "Every detected value bet, no filters — the 'do nothing smart' control cohort.",
    example:
      "Last 30 days: 1,420 detected bets, avg EV +1.4%, ROI +1.1%. The floor every smarter cohort must clear. Simple EV Rule doesn't beat it ⇒ rule is over-filtering. Model Gate doesn't beat the rule ⇒ model isn't earning its complexity.",
  },
  simple_ev_rule: {
    short:
      "Pass-through filter: EV ≥ minEvPct AND market ∈ allowedMarkets.",
    example:
      "Of 1,420 detected bets, 640 had EV ≥ 2% on Asian Handicap / 1X2 / O/U 2.5 / BTTS → +2.8% ROI. This is the live deterministic strategy; the model has to deliver more than this for its complexity to be worth it.",
  },
  model_scored: {
    short:
      "Bets where mlScore ≠ NULL — every detected bet whose 25 features were warm at detection time.",
    example:
      "1,310 of 1,420 detected bets had all 25 features warm (sharp odds, convergence, steam present) and got scored. The other 110 came in cold and were skipped. This is the population the model can claim authority over.",
  },
  model_gate: {
    short:
      "Pass-through filter: Simple EV Rule ∧ positive model EV at offered odds.",
    example:
      "Of 640 Simple EV Rule bets, 480 also had positive model EV at the offered odds → +4.1% ROI vs the rule's +2.8% (Lift = +1.3 pts). The 160 bets the gate rejected returned -0.8% — exactly the bets the gate is meant to remove.",
  },
  permission_level: {
    short:
      "Observe < Gate Only < Stake Reduce < Stake Increase.  Each level expands the multiplier range the staker can apply.",
    example:
      "Observe: × ∈ ∅ (no effect, log only). Gate Only: × ∈ {0, 1} (skip or pass-through). Stake Reduce: × ∈ [0, 1.0] (shrink, never increase). Stake Increase: × ∈ [0, 2.0] (full authority). New models start at Observe and earn each step from paper-trading evidence.",
  },
  auto_retrain: {
    short:
      "Trigger: corpusSize ≥ lastDeployedSize + retrainStep (default 200 examples).  No schedule, no cadence.",
    example:
      "Step = 200, last deployed trained on 4,500 examples. Once corpus ≥ 4,700, the scheduler fires a new training run on the next tick. Manual retrain is always available — auto is the floor that prevents stale models.",
  },
  cold_start_threshold: {
    short:
      "Minimum qualified examples before any model can train.  threshold = 1,000.",
    example:
      "Below 1,000, the engine collects bets and extracts features but no model trains — not enough signal to separate skill from luck. Once 1,000 settled bets pass the feature contract with positive EV labels, the first model trains and enters Observe permission.",
  },
  feature_contract: {
    short:
      "Tuple (version, count, names_hash) that every stored feature vector must match.  Drift breaks scoring silently.",
    example:
      "Current contract: version = 2, count = 25, names_hash = a3f9…b2. A bet stored with version = 1 (count = 24) can't be scored by the v2 model — feature[12] would be 'persistence_ticks' for the writer but 'sharp_steam_60s' for the reader, score becomes nonsense. The contract check rejects mismatched bets before training or scoring.",
  },
} satisfies Record<string, GlossaryEntry>;

export function getTerm(id: TermId): GlossaryEntry {
  return GLOSSARY[id];
}
