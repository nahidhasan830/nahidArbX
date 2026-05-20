import { FEATURE_NAMES } from "./feature-contract";

const F = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i]),
) as Record<string, number>;

const MODEL_EDGE_FULL_SCALE_PCT = 10;

type Tone = "positive" | "negative" | "neutral";

interface DecisionReasonTechnical {
  label: string;
  value: string;
  detail: string;
  tone: Tone;
}

export type DecisionDriver =
  | "strong_edge"
  | "moderate_edge"
  | "persistence"
  | "steam"
  | "convergence"
  | "negative_edge"
  | "low_edge"
  | "no_signal";

export interface DriverInfo {
  decision: "boost" | "shrink" | "skip" | "agree";
  driver: DecisionDriver;
  driverLabel: string;
}

export interface SimilarBetsContext {
  decision: "boost" | "shrink" | "skip" | "agree";
  driver: DecisionDriver;
  driverLabel: string;
  recentWins: number;
  recentLosses: number;
  recentTotal: number;
  unitPnl: number;
}

export interface DecisionReason {
  decision: "boost" | "shrink" | "skip" | "agree";
  multiplier: number;
  explanation: string[];
  technical: DecisionReasonTechnical[];
  multiplierChain: string;
  similar?: {
    decision: "boost" | "shrink" | "skip" | "agree";
    driver: DecisionDriver;
    driverLabel: string;
    wins: number;
    losses: number;
    text: string;
    pnlText: string;
    note?: string;
  };
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function scoreConfidence(v: number): string {
  if (v >= 0.6) return "High";
  if (v >= 0.4) return "Moderate";
  return "Low";
}

function getOdds(features: number[]): number {
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  return adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
}

const DRIVER_LABELS: Record<DecisionDriver, string> = {
  strong_edge: "Strong edge",
  moderate_edge: "Moderate edge",
  persistence: "Persistent value",
  steam: "Market confirmed",
  convergence: "Odds closing",
  negative_edge: "Negative edge",
  low_edge: "Thin edge",
  no_signal: "No clear signal",
};

export function classifyDecisionDriver(
  mlScore: number | null,
  features: number[],
  multiplier: number,
): DriverInfo {
  const decision = classifyModelStance(multiplier);
  const modelEdgePct = computeModelEdgePct(mlScore, features);
  const steamSharp = features[F.steam_move_sharp] ?? 0;
  const tickCount = features[F.tick_count] ?? 0;
  const convergence = features[F.convergence_rate] ?? 0;
  const edgeScaling = 0.5 + Math.min(modelEdgePct, MODEL_EDGE_FULL_SCALE_PCT) / MODEL_EDGE_FULL_SCALE_PCT;

  let driver: DecisionDriver;

  switch (decision) {
    case "boost": {
      const steamContrib = steamSharp > 0 ? 1.3 : 1;
      const persContrib = tickCount > 10 ? 1.2 : 1;
      const edgeContrib = edgeScaling;
      if (steamContrib > persContrib && steamContrib > edgeContrib) driver = "steam";
      else if (persContrib > edgeContrib) driver = "persistence";
      else if (modelEdgePct > 10) driver = "strong_edge";
      else driver = "moderate_edge";
      break;
    }
    case "shrink": {
      if (convergence < 0) driver = "convergence";
      else if (modelEdgePct <= 0) driver = "negative_edge";
      else driver = "low_edge";
      break;
    }
    case "skip": {
      driver = modelEdgePct <= 0 ? "negative_edge" : "low_edge";
      break;
    }
    case "agree": {
      driver = "no_signal";
      break;
    }
  }

  return {
    decision,
    driver,
    driverLabel: `${DRIVER_LABELS[driver]} ${decision}s`,
  };
}

export function buildDecisionReason(
  mlScore: number | null,
  features: number[],
  multiplier: number,
  similarContext?: SimilarBetsContext | null,
): DecisionReason {
  const modelEdgePct = computeModelEdgePct(mlScore, features);
  const scoreVal = mlScore != null && Number.isFinite(mlScore) ? mlScore : 0;
  const steamSharp = features[F.steam_move_sharp] ?? 0;
  const tickCount = features[F.tick_count] ?? 0;
  const convergence = features[F.convergence_rate] ?? 0;

  const edgeScaling = 0.5 + Math.min(modelEdgePct, MODEL_EDGE_FULL_SCALE_PCT) / MODEL_EDGE_FULL_SCALE_PCT;
  const convergencePenalty = convergence < 0 ? Math.max(0.5, 1 + convergence) : 1;
  const persistenceBonus = tickCount > 10 ? 1.2 : 1;
  const steamBonus = steamSharp > 0 ? 1.3 : 1;

  const decision = classifyModelStance(multiplier);
  const explanation = buildExplanation(decision, modelEdgePct, scoreVal, steamSharp, tickCount, convergence, features, multiplier);
  const technical = buildTechnical(modelEdgePct, scoreVal, steamSharp, tickCount, convergence, edgeScaling, convergencePenalty, persistenceBonus, steamBonus, decision);
  const multiplierChain = buildMultiplierChain(decision, edgeScaling, convergencePenalty, persistenceBonus, steamBonus);

  const similar = similarContext && similarContext.recentTotal >= 3
    ? buildSimilarSection(similarContext, similarContext.decision)
    : undefined;

  return { decision, multiplier, explanation, technical, multiplierChain, similar };
}

// ── Decision classification ─────────────────────────────────────────────────

function classifyModelStance(mult: number): "boost" | "shrink" | "skip" | "agree" {
  if (mult < 0.1) return "skip";
  if (mult < 0.95) return "shrink";
  if (mult > 1.05) return "boost";
  return "agree";
}

// ── Plain-language explanations (non-technical audience) ────────────────────

function buildExplanation(
  decision: "boost" | "shrink" | "skip" | "agree",
  modelEdgePct: number,
  scoreVal: number,
  steamSharp: number,
  tickCount: number,
  convergence: number,
  features: number[],
  multiplier: number,
): string[] {
  const lines: string[] = [];
  const confidence = scoreConfidence(scoreVal);

  switch (decision) {
    case "boost": {
      const odds = getOdds(features);
      const impliedProb = odds > 1.01 ? Math.round((1 / odds) * 100) : null;
      const modelProb = Math.round(scoreVal * 100);
      const hasStrongEdge = modelEdgePct > 5;
      const hasPersistence = tickCount > 10;
      const hasSteam = steamSharp > 0;

      if (impliedProb != null && modelProb > impliedProb) {
        if (hasStrongEdge) {
          lines.push(
            `The model estimates a ${modelProb}% win probability but the market implies only ${impliedProb}% — a ${modelProb - impliedProb}-point value gap (${confidence.toLowerCase()} confidence).`,
          );
        } else {
          lines.push(
            `The model estimates a ${modelProb}% win probability vs ${impliedProb}% implied — a ${modelProb - impliedProb}-point edge (${confidence.toLowerCase()} confidence).`,
          );
        }
      } else if (impliedProb != null) {
        lines.push(
          `The model estimates a ${modelProb}% win probability against ${impliedProb}% implied — a ${pct(modelEdgePct)} edge (${confidence.toLowerCase()} confidence).`,
        );
      } else {
        lines.push(
          `The model estimates a ${modelProb}% win probability with a ${Math.abs(modelEdgePct).toFixed(0)}% edge (${confidence.toLowerCase()} confidence).`,
        );
      }

      if (hasPersistence && !hasStrongEdge) {
        lines.push(
          `The bet persisted through ${tickCount} market updates — this level of staying power is rare and suggests genuine value that the market hasn't spotted yet, which is why the model boosted to ${multiplier.toFixed(2)}×.`,
        );
      } else if (hasPersistence) {
        lines.push(
          `The bet persisted through ${tickCount} market updates — real value tends to hold while noise fades quickly.`,
        );
      }

      if (hasSteam && !hasStrongEdge && !hasPersistence) {
        lines.push(
          `Pinnacle moved sharply in the same direction — this independent confirmation led the model to boost to ${multiplier.toFixed(2)}×.`,
        );
      } else if (hasSteam) {
        lines.push(
          "Pinnacle moved sharply in the same direction, independently confirming the value signal.",
        );
      }

      if (convergence >= 0) {
        lines.push(
          "Odds are stable — no sign the market is correcting the mispricing.",
        );
      }
      break;
    }
    case "shrink": {
      if (modelEdgePct <= 0) {
        lines.push(
          "The model estimates this bet is not +EV at the offered odds.",
        );
      } else {
        lines.push(
          `The model sees moderate value (${pct(modelEdgePct)} edge, ${confidence.toLowerCase()} confidence) but flags are dampening the signal.`,
        );
      }
      if (convergence < 0) {
        lines.push(
          `Convergence is at ${pct(convergence * 100)}/min — the odds gap is closing, so the model reduced the stake.`,
        );
      }
      if (tickCount <= 10 && steamSharp === 0) {
        lines.push(
          "No persistence or sharp confirmation — the signal lacks supporting evidence for a full stake.",
        );
      }
      break;
    }
    case "skip": {
      if (modelEdgePct <= 0) {
        const odds = getOdds(features);
        const impliedProb = odds > 1.01 ? Math.round((1 / odds) * 100) : null;
        const modelProb = Math.round(scoreVal * 100);
        if (impliedProb != null && impliedProb > modelProb) {
          lines.push(
            `The model estimates a ${modelProb}% win probability, but the odds imply ${impliedProb}% is needed to break even — a ${impliedProb - modelProb}-point gap. Over many bets like this, the model expects to lose ${Math.abs(modelEdgePct).toFixed(1)}% per stake.`,
          );
        } else if (impliedProb != null) {
          lines.push(
            `The model estimates a ${modelProb}% win probability at odds implying ${impliedProb}%. The edge is ${pct(modelEdgePct)} — not enough value to justify a stake.`,
          );
        } else {
          lines.push(
            `The model estimates this bet is not +EV at the offered odds — edge is ${pct(modelEdgePct)}.`,
          );
        }
      } else {
        lines.push(
          `Model edge of ${pct(modelEdgePct)} is too low to justify a stake.`,
        );
      }
      break;
    }
    case "agree": {
      lines.push(
        `The model sees ${pct(modelEdgePct)} value (${confidence.toLowerCase()} confidence) — nothing flagged to adjust the normal stake.`,
      );
      break;
    }
  }

  return lines;
}

// ── Technical breakdown (technical audience) ────────────────────────────────

function buildTechnical(
  modelEdgePct: number,
  scoreVal: number,
  steamSharp: number,
  tickCount: number,
  convergence: number,
  edgeScaling: number,
  convergencePenalty: number,
  persistenceBonus: number,
  steamBonus: number,
  decision: "boost" | "shrink" | "skip" | "agree",
): DecisionReasonTechnical[] {
  const items: DecisionReasonTechnical[] = [];

  // Model edge — always shown
  items.push({
    label: "Model Edge",
    value: pct(modelEdgePct),
    detail: "mlScore × odds − 1 → PnL per unit at offered price",
    tone: modelEdgePct > 5 ? "positive" : modelEdgePct < 0 ? "negative" : "neutral",
  });

  // Score
  const confidence = scoreConfidence(scoreVal);
  items.push({
    label: "Score",
    value: `${scoreVal.toFixed(2)} (${confidence})`,
    detail: `Win probability estimate (${confidence.toLowerCase()} confidence range)`,
    tone: scoreVal >= 0.6 ? "positive" : scoreVal <= 0.4 ? "negative" : "neutral",
  });

  if (decision === "skip") return items;

  // Edge scaling
  const edgePctContribution = (edgeScaling * 100).toFixed(0);
  items.push({
    label: "Edge Scaling",
    value: `${edgeScaling.toFixed(2)}×`,
    detail: `0.5 + ${Math.min(modelEdgePct, 10).toFixed(1)}/10 → ${edgePctContribution}% of max multiplier`,
    tone: edgeScaling > 1 ? "positive" : "neutral",
  });

  // Convergence
  if (convergence < 0 && convergencePenalty < 1) {
    items.push({
      label: "Convergence",
      value: `${pct(convergence * 100)} (${convergencePenalty.toFixed(2)}× penalty)`,
      detail: "Odds closing toward fair value → stake reduced to avoid fading edge",
      tone: "negative",
    });
  } else {
    items.push({
      label: "Convergence",
      value: "Stable (no penalty)",
      detail: "Odds movement is neutral — no value decay signal",
      tone: "neutral",
    });
  }

  // Persistence
  if (tickCount > 10) {
    items.push({
      label: "Persistence",
      value: `${tickCount} ticks (+20% bonus)`,
      detail: "Bet persisted through >10 odds updates → signal is unlikely to be noise",
      tone: "positive",
    });
  } else if (steamSharp === 0 && convergence >= 0) {
    items.push({
      label: "Persistence",
      value: `${tickCount} ticks (no bonus)`,
      detail: "Below 10-tick threshold — no persistence signal",
      tone: "neutral",
    });
  }

  // Steam
  if (steamSharp > 0) {
    items.push({
      label: "Steam",
      value: "Sharp ✓ (+30% bonus)",
      detail: "Pinnacle moved ≥3% in 60s in same direction → market validating the edge",
      tone: "positive",
    });
  }

  return items;
}

// ── Multiplier chain ────────────────────────────────────────────────────────

function buildMultiplierChain(
  decision: "boost" | "shrink" | "skip" | "agree",
  edgeScaling: number,
  convergencePenalty: number,
  persistenceBonus: number,
  steamBonus: number,
): string {
  if (decision === "skip") return "Edge ≤ 0% → skip (0×)";

  const factors: number[] = [1.0];
  if (Math.abs(edgeScaling - 1) > 0.005) factors.push(parseFloat(edgeScaling.toFixed(2)));
  if (Math.abs(convergencePenalty - 1) > 0.005) factors.push(parseFloat(convergencePenalty.toFixed(2)));
  if (persistenceBonus > 1.005) factors.push(1.2);
  if (steamBonus > 1.005) factors.push(1.3);

  const product = factors.reduce((a, b) => a * b, 1);

  if (factors.length <= 1) {
    return "1.0 = 1.00× (no adjustments needed)";
  }

  const chain = factors.map((f) => f.toFixed(2)).join(" × ");
  return `${chain} = ${product.toFixed(2)}×`;
}

// ── Similar bets section ────────────────────────────────────────────────────

function buildSimilarSection(
  ctx: SimilarBetsContext,
  decision: "boost" | "shrink" | "skip" | "agree",
): {
  decision: "boost" | "shrink" | "skip" | "agree";
  driver: DecisionDriver;
  driverLabel: string;
  wins: number;
  losses: number;
  text: string;
  pnlText: string;
  note?: string;
} {
  const total = ctx.recentWins + ctx.recentLosses;
  const winRate = total > 0 ? Math.round((ctx.recentWins / total) * 100) : 0;
  const pnlSign = ctx.unitPnl >= 0 ? "+" : "";

  let note: string | undefined;
  if (ctx.unitPnl > 0) {
    // Profitable — no warning needed regardless of win rate
  } else if (decision === "skip" && winRate >= 55) {
    note =
      "Similar calls performed well overall, but the model skips individual bets where the specific odds don't compensate for the estimated risk — it evaluates each bet independently.";
  } else if (decision === "skip" && winRate >= 50) {
    note =
      "Similar calls break even — the model's conservative stance avoids marginal bets where the odds don't offer a clear edge.";
  } else if (decision === "boost" && winRate < 40) {
    note =
      "Similar calls have lost overall — the model evaluates each bet on its own signals, not by category averages.";
  } else if (decision === "boost" && winRate < 50) {
    note =
      "Similar calls are underperforming — the model evaluates each bet on its own edge, persistence, and market signals, not by category averages.";
  }

  return {
    decision: ctx.decision,
    driver: ctx.driver,
    driverLabel: ctx.driverLabel,
    wins: ctx.recentWins,
    losses: ctx.recentLosses,
    text: `${ctx.recentWins} of last ${total} won (${winRate}%)`,
    pnlText: `P&L ${pnlSign}${ctx.unitPnl.toFixed(1)}u`,
    note,
  };
}

// ── Edge computation ────────────────────────────────────────────────────────

function computeModelEdgePct(
  mlScore: number | null,
  features: number[],
): number {
  if (mlScore == null || !Number.isFinite(mlScore)) return -100;
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const odds = adjustedSoftOdds > 1.01 ? adjustedSoftOdds : softOdds;
  if (!Number.isFinite(odds) || odds <= 1.01) return -100;
  return (mlScore * odds - 1) * 100;
}
