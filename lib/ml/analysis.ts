import { FEATURE_NAMES } from "./features";
import type {
  AnalysisBucket,
  AnalysisResponse,
  AnalysisSignal,
  ConfidenceSection,
  EdgeTier,
  FactorTone,
  ModelStance,
  NumbersSection,
  SimilarBetRow,
  StorySection,
  TrackRecordSection,
} from "./analysis-types";

const F = Object.fromEntries(
  FEATURE_NAMES.map((n, i) => [n, i]),
) as Record<string, number>;

interface AnalysisMetrics {
  modelEdgePct: number;
  modelScore: number;
  modelProbability: number;
  odds: number;
  impliedProbability: number;
  probabilityGap: number;
  scannerEdgePct: number | null;
  tickCount: number;
  convergenceRate: number;
  steamSharp: number;
}

export interface BuildAnalysisParams {
  bet: {
    id: string;
    homeTeam: string | null;
    awayTeam: string | null;
    competition: string | null;
    marketType: string | null;
    softOdds: number | string | null;
    mlScore: number | null;
  };
  features: number[];
  multiplier: number;
  bucket?: AnalysisBucket;
  similarBets: SimilarBetRow[];
}

export function classifyModelStance(multiplier: number): ModelStance {
  if (!Number.isFinite(multiplier)) return "agree";
  if (multiplier < 0.1) return "skip";
  if (multiplier < 0.95) return "shrink";
  if (multiplier > 1.05) return "boost";
  return "agree";
}

export function classifyEdgeTier(modelEdgePct: number): EdgeTier {
  if (modelEdgePct < -10) return "negative_edge_deep";
  if (modelEdgePct < -3) return "negative_edge_moderate";
  if (modelEdgePct < 0) return "negative_edge_mild";
  if (modelEdgePct <= 5) return "positive_edge_moderate";
  if (modelEdgePct <= 10) return "positive_edge_strong";
  return "positive_edge_deep";
}

export function getAnalysisSignals(features: number[]): AnalysisSignal[] {
  const signals: AnalysisSignal[] = [];
  if ((features[F.steam_move_sharp] ?? 0) > 0) signals.push("steam");
  if ((features[F.tick_count] ?? 0) > 10) signals.push("persistence");
  if ((features[F.convergence_rate] ?? 0) < 0) {
    signals.push("convergence_fading");
  }
  return signals;
}

export function computeAnalysisMetrics(params: {
  mlScore: number | null;
  features: number[];
  fallbackOdds?: number | string | null;
}): AnalysisMetrics {
  const modelScore =
    params.mlScore != null && Number.isFinite(params.mlScore)
      ? params.mlScore
      : 0;
  const odds = getOdds(params.features, params.fallbackOdds);
  const impliedProbability = odds > 1.01 ? (1 / odds) * 100 : 0;
  const modelProbability = modelScore * 100;
  const modelEdgePct =
    odds > 1.01 && Number.isFinite(modelScore)
      ? (modelScore * odds - 1) * 100
      : -100;
  const scannerEdge = params.features[F.ev_pct];

  return {
    modelEdgePct,
    modelScore,
    modelProbability,
    odds,
    impliedProbability,
    probabilityGap: modelProbability - impliedProbability,
    scannerEdgePct:
      scannerEdge != null && Number.isFinite(scannerEdge)
        ? scannerEdge
        : null,
    tickCount: params.features[F.tick_count] ?? 0,
    convergenceRate: params.features[F.convergence_rate] ?? 0,
    steamSharp: params.features[F.steam_move_sharp] ?? 0,
  };
}

export function classifyAnalysisBucket(params: {
  decision: ModelStance;
  edgeTier: EdgeTier;
  signals: AnalysisSignal[];
}): AnalysisBucket {
  const hasSteam = params.signals.includes("steam");
  const hasPersistence = params.signals.includes("persistence");
  const hasFading = params.signals.includes("convergence_fading");

  if (params.decision === "agree") return "no_signal";
  if (params.decision === "shrink" && hasFading) return "convergence";

  if (params.decision === "boost") {
    if (params.edgeTier === "positive_edge_moderate" && hasSteam) {
      return "steam";
    }
    if (params.edgeTier === "positive_edge_moderate" && hasPersistence) {
      return "persistence";
    }
  }

  return params.edgeTier;
}

export function computeConfidence(
  modelEdgePct: number,
  signals: AnalysisSignal[] = [],
): ConfidenceSection {
  let score = 0;
  const reasons: string[] = [];

  if (modelEdgePct > 15) {
    score += 3;
    reasons.push(`Deep positive edge (${formatPct(modelEdgePct)})`);
  } else if (modelEdgePct > 10) {
    score += 2;
    reasons.push(`Strong positive edge (${formatPct(modelEdgePct)})`);
  } else if (modelEdgePct > 5) {
    score += 1;
    reasons.push(`Moderate positive edge (${formatPct(modelEdgePct)})`);
  } else if (modelEdgePct > 0) {
    reasons.push(`Thin positive edge (${formatPct(modelEdgePct)})`);
  } else if (modelEdgePct > -5) {
    score -= 1;
    reasons.push(`Small negative edge (${formatPct(modelEdgePct)})`);
  } else {
    score -= 2;
    reasons.push(`Negative model edge (${formatPct(modelEdgePct)})`);
  }

  if (signals.includes("steam")) {
    score += 1;
    reasons.push("Sharp steam confirms the side");
  }
  if (signals.includes("persistence")) {
    score += 1;
    reasons.push("Price persisted beyond 10 ticks");
  }
  if (signals.includes("convergence_fading")) {
    score -= 1;
    reasons.push("Odds are converging, so value is fading");
  }
  if (signals.length === 0) reasons.push("No confirming market signals");

  if (score >= 4) return { stars: 5, label: "Excellent", reasons };
  if (score >= 3) return { stars: 4, label: "Strong", reasons };
  if (score >= 2) return { stars: 3, label: "Good", reasons };
  if (score >= 1) return { stars: 2, label: "Fair", reasons };
  if (score >= 0) return { stars: 1, label: "Weak", reasons };
  return { stars: 1, label: "Poor", reasons };
}

export function buildTrackRecord(params: {
  bucket: AnalysisBucket;
  decision: ModelStance;
  modelEdgePct: number;
  similarBets: SimilarBetRow[];
}): TrackRecordSection {
  const graded = params.similarBets.filter((bet) =>
    isWinOutcome(bet.outcome) || isLossOutcome(bet.outcome),
  );
  const wins = graded.filter((bet) => isWinOutcome(bet.outcome)).length;
  const losses = graded.filter((bet) => isLossOutcome(bet.outcome)).length;
  const total = wins + losses;
  const unitPnl = params.similarBets.reduce((sum, bet) => sum + bet.unitPnl, 0);
  const avgEdge =
    params.similarBets.length > 0
      ? params.similarBets.reduce((sum, bet) => sum + bet.modelEdge, 0) /
        params.similarBets.length
      : 0;

  return {
    bucket: params.bucket,
    bucketLabel: bucketLabel(params.bucket, params.decision),
    wins,
    losses,
    total,
    winRate: total > 0 ? round1((wins / total) * 100) : 0,
    unitPnl: round2(unitPnl),
    unitPnlFormatted: formatUnits(unitPnl),
    avgEdge: round1(avgEdge),
    avgEdgeFormatted: formatPct(avgEdge),
    note: buildTrackNote({
      bucket: params.bucket,
      decision: params.decision,
      modelEdgePct: params.modelEdgePct,
      avgEdge,
      total,
      unitPnl,
    }),
  };
}

export function buildAnalysis(params: BuildAnalysisParams): AnalysisResponse {
  const metrics = computeAnalysisMetrics({
    mlScore: params.bet.mlScore,
    features: params.features,
    fallbackOdds: params.bet.softOdds,
  });
  const decisionType = classifyModelStance(params.multiplier);
  const edgeTier = classifyEdgeTier(metrics.modelEdgePct);
  const signals = getAnalysisSignals(params.features);
  const bucket =
    params.bucket ??
    classifyAnalysisBucket({ decision: decisionType, edgeTier, signals });
  const decision = buildDecision(decisionType, params.multiplier);
  const story = buildStory({
    decision: decisionType,
    multiplier: params.multiplier,
    edgeTier,
    bucket,
    metrics,
    signals,
  });
  const numbers = buildNumbers(metrics, decisionType);
  const confidence = computeConfidence(metrics.modelEdgePct, signals);
  const trackRecord = buildTrackRecord({
    bucket,
    decision: decisionType,
    modelEdgePct: metrics.modelEdgePct,
    similarBets: params.similarBets,
  });

  return {
    bet: {
      id: params.bet.id,
      homeTeam: params.bet.homeTeam,
      awayTeam: params.bet.awayTeam,
      competition: params.bet.competition,
      marketType: params.bet.marketType,
      softOdds: metrics.odds,
      mlScore: params.bet.mlScore,
    },
    decision,
    story,
    numbers,
    confidence,
    trackRecord,
    similarBets: params.similarBets.slice(0, 10),
  };
}

export function computeUnitPnl(outcome: string, odds: number | null): number {
  const safeOdds = odds != null && Number.isFinite(odds) ? odds : 0;
  if (safeOdds <= 1) return 0;

  if (outcome === "won") return round2(safeOdds - 1);
  if (outcome === "half_won") return round2((safeOdds - 1) / 2);
  if (outcome === "lost") return -1;
  if (outcome === "half_lost") return -0.5;
  return 0;
}

function buildDecision(type: ModelStance, multiplier: number) {
  const meta: Record<ModelStance, { icon: string; label: string }> = {
    skip: { icon: "🚫", label: "Skip" },
    shrink: { icon: "⬇️", label: "Shrink" },
    agree: { icon: "✓", label: "Agree" },
    boost: { icon: "🚀", label: "Boost" },
  };
  return {
    type,
    multiplier: round2(Number.isFinite(multiplier) ? multiplier : 1),
    icon: meta[type].icon,
    label: meta[type].label,
  };
}

function buildStory(params: {
  decision: ModelStance;
  multiplier: number;
  edgeTier: EdgeTier;
  bucket: AnalysisBucket;
  metrics: AnalysisMetrics;
  signals: AnalysisSignal[];
}): StorySection {
  const m = params.metrics;
  const perDollar = round3(m.modelEdgePct / 100);
  const dollarImpact = {
    perDollar,
    over100Bets: round2(perDollar * 100),
  };
  const modelProb = `${round0(m.modelProbability)}%`;
  const implied = `${round0(m.impliedProbability)}%`;
  const gap = `${Math.abs(round0(m.probabilityGap))} points`;
  const edge = formatPct(m.modelEdgePct);

  if (params.decision === "skip") {
    if (params.edgeTier === "negative_edge_deep") {
      return {
        severity: "critical",
        emoji: "🚫",
        title: "The Price Is Brutal",
        paragraphs: [
          `The book price needs ${implied} to break even. The model lands at ${modelProb}.`,
          `That ${gap} gap creates ${edge} expected return, so every dollar staked is priced to lose about ${formatCents(Math.abs(perDollar))}.`,
          "The model skips because the offered odds are not paying enough for the estimated risk.",
        ],
        dollarImpact,
      };
    }

    if (params.edgeTier === "negative_edge_mild") {
      return {
        severity: "warning",
        emoji: "🚫",
        title: "Barely Not Worth It",
        paragraphs: [
          `The model is only slightly under break-even at ${edge}. This is close enough to look tempting, but the margin is not real value.`,
          "These bets can win in small samples. The model skips because there is no durable advantage to pay for the risk.",
        ],
        dollarImpact,
      };
    }

    return {
      severity: "critical",
      emoji: "🚫",
      title: "Negative Edge",
      paragraphs: [
        `The model needs a better price. It sees ${modelProb} against a ${implied} break-even requirement.`,
        `That leaves a ${gap} gap and ${edge} expected return. The skip protects the bankroll from a bad price.`,
      ],
      dollarImpact,
    };
  }

  if (params.decision === "shrink") {
    const fading = params.signals.includes("convergence_fading");
    return {
      severity: "warning",
      emoji: "⬇️",
      title: fading ? "Value, But Fading" : "Positive, But Thin",
      paragraphs: [
        fading
          ? `The model still sees ${edge} value, but the odds are moving toward fair value. The window is closing.`
          : `The model sees ${edge} value, but it is too thin for a full stake.`,
        `The stake is cut to ${formatMultiplier(params.multiplier)} because the edge is positive but not strong enough to carry full exposure.`,
        buildSignalSentence(params.signals, m.tickCount),
      ],
      dollarImpact,
    };
  }

  if (params.decision === "agree") {
    return {
      severity: "neutral",
      emoji: "✓",
      title: "Fair Value, Nothing Special",
      paragraphs: [
        `The model sees ${edge} at ${m.odds.toFixed(2)} odds. That is close to a normal bet, not a clear boost or cut.`,
        "There is no strong penalty signal and no strong confirmation signal, so the model keeps the standard stake.",
      ],
      dollarImpact,
    };
  }

  if (params.edgeTier === "positive_edge_deep") {
    return {
      severity: "positive",
      emoji: "🚀",
      title: "The Model Sees a Steal",
      paragraphs: [
        `The book price implies ${implied}. The model estimates ${modelProb}, a ${gap} gap in our favor.`,
        `That is ${edge} expected return per dollar before staking rules. The model boosts because the price is materially under what the model thinks is fair.`,
        buildSignalSentence(params.signals, m.tickCount),
      ],
      dollarImpact,
    };
  }

  return {
    severity: "positive",
    emoji: "🚀",
    title: "Solid Value Here",
    paragraphs: [
      `The book price implies ${implied}. The model estimates ${modelProb}, leaving a ${gap} value gap.`,
      `Expected return is ${edge} per dollar. The boost is sized to the edge and capped by the model's multiplier logic.`,
      buildSignalSentence(params.signals, m.tickCount),
    ],
    dollarImpact,
  };
}

function buildNumbers(
  metrics: AnalysisMetrics,
  decision: ModelStance,
): NumbersSection {
  // Only signal-based factors — core numbers (edge, prob, gap, odds) are
  // returned as top-level fields and displayed in the summary strip.
  const factors: NumbersSection["factors"] = [];

  if (metrics.scannerEdgePct != null) {
    factors.push({
      name: "Scanner Edge",
      value: formatPct(metrics.scannerEdgePct),
      detail: "Original sharp-vs-soft value signal at detection",
      tone: toneFromNumber(metrics.scannerEdgePct, 2, 5),
    });
  }

  if (decision !== "skip" || metrics.tickCount > 0) {
    factors.push({
      name: "Persistence",
      value:
        metrics.tickCount > 10
          ? `${round0(metrics.tickCount)} ticks`
          : `${round0(metrics.tickCount)} ticks`,
      detail:
        metrics.tickCount > 10
          ? "Price survived enough updates to earn a persistence bonus"
          : "Below the persistence bonus threshold",
      tone: metrics.tickCount > 10 ? "positive" : "neutral",
    });
  }

  if (metrics.convergenceRate < 0) {
    factors.push({
      name: "Convergence",
      value: `${formatPct(metrics.convergenceRate * 100)}/min`,
      detail: "Odds gap is closing, so value is fading",
      tone: "negative",
    });
  } else if (decision === "boost" || decision === "agree") {
    factors.push({
      name: "Convergence",
      value: "Stable",
      detail: "No active value-decay penalty",
      tone: "neutral",
    });
  }

  if (metrics.steamSharp > 0) {
    factors.push({
      name: "Sharp Steam",
      value: "Active",
      detail: "Sharp market moved in the same direction",
      tone: "positive",
    });
  }

  return {
    modelEdge: round1(metrics.modelEdgePct),
    modelEdgeFormatted: formatPct(metrics.modelEdgePct),
    modelScore: round3(metrics.modelScore),
    modelScoreFormatted: formatProbability(metrics.modelProbability),
    odds: round4(metrics.odds),
    impliedProbability: round1(metrics.impliedProbability),
    gap: round1(metrics.probabilityGap),
    gapFormatted: formatPoints(metrics.probabilityGap),
    factors,
  };
}

function buildTrackNote(params: {
  bucket: AnalysisBucket;
  decision: ModelStance;
  modelEdgePct: number;
  avgEdge: number;
  total: number;
  unitPnl: number;
}): string {
  if (params.total === 0) {
    return "No resolved bets in this bucket for the selected range yet. Treat this as a model-only read, not a proven historical pattern.";
  }

  const worseThanBucket = params.modelEdgePct < params.avgEdge;
  const edgeDelta = Math.abs(params.modelEdgePct - params.avgEdge);

  if (params.bucket === "negative_edge_mild" && params.unitPnl > 0) {
    return "This mild-negative bucket is up in the sample, but that is variance-prone territory. The model still skips because the individual price does not clear break-even.";
  }

  if (String(params.bucket).startsWith("negative_edge")) {
    if (params.unitPnl < 0) {
      return worseThanBucket
        ? `This bucket has been unprofitable, and this bet is ${round1(edgeDelta)} points worse than the bucket average.`
        : "This bucket has been unprofitable overall. The skip is consistent with the historical result.";
    }
    return "This bucket has not lost over the selected sample, but the model still prices this individual bet below break-even.";
  }

  if (params.bucket === "convergence") {
    return params.unitPnl < 0
      ? "Fading-value shrinks have struggled in the sample, so the model is limiting exposure."
      : "Fading-value shrinks have held up, but the model still trims size because the price is moving against the edge.";
  }

  if (params.decision === "boost") {
    return params.unitPnl >= 0
      ? "Similar boosts have been profitable in the selected range, which supports the larger stake."
      : "Similar boosts are down in the selected range. The model is leaning on this bet's current edge rather than the bucket average.";
  }

  if (params.decision === "agree") {
    return "This is the model's neutral bucket: normal stake, no strong penalty, and no strong boost signal.";
  }

  return "This track record is a context check, not the sizing rule. The current edge and signals drive the model call.";
}

function buildSignalSentence(signals: AnalysisSignal[], tickCount: number): string {
  const parts: string[] = [];
  if (signals.includes("persistence")) {
    parts.push(`price persisted for ${round0(tickCount)} ticks`);
  }
  if (signals.includes("steam")) parts.push("sharp steam confirmed the side");
  if (signals.includes("convergence_fading")) {
    parts.push("odds are converging against the edge");
  }

  if (parts.length === 0) {
    return "There are no extra market-confirmation signals, so the decision rests mostly on the model edge.";
  }
  return `Key signal${parts.length > 1 ? "s" : ""}: ${parts.join("; ")}.`;
}

function bucketLabel(bucket: AnalysisBucket, decision: ModelStance): string {
  const decisionPlural: Record<ModelStance, string> = {
    skip: "Skips",
    shrink: "Shrinks",
    agree: "Agrees",
    boost: "Boosts",
  };
  const labels: Record<AnalysisBucket, string> = {
    negative_edge_deep: `Deep Negative Edge ${decisionPlural[decision]}`,
    negative_edge_moderate: `Moderate Negative Edge ${decisionPlural[decision]}`,
    negative_edge_mild: `Mild Negative Edge ${decisionPlural[decision]}`,
    positive_edge_moderate: `Moderate Positive Edge ${decisionPlural[decision]}`,
    positive_edge_strong: `Strong Positive Edge ${decisionPlural[decision]}`,
    positive_edge_deep: `Deep Positive Edge ${decisionPlural[decision]}`,
    persistence: `Persistent-Value ${decisionPlural[decision]}`,
    steam: `Market-Confirmed ${decisionPlural[decision]}`,
    convergence: `Fading-Value ${decisionPlural[decision]}`,
    no_signal: `Fair-Value ${decisionPlural[decision]}`,
  };
  return labels[bucket];
}

function getOdds(features: number[], fallbackOdds?: number | string | null): number {
  const adjustedSoftOdds = features[F.adjusted_soft_odds] ?? 0;
  const softOdds = features[F.soft_odds] ?? 0;
  const fallback = Number(fallbackOdds ?? 0);
  if (Number.isFinite(adjustedSoftOdds) && adjustedSoftOdds > 1.01) {
    return adjustedSoftOdds;
  }
  if (Number.isFinite(softOdds) && softOdds > 1.01) return softOdds;
  if (Number.isFinite(fallback) && fallback > 1.01) return fallback;
  return 0;
}

function toneFromNumber(
  value: number,
  positiveThreshold: number,
  strongThreshold: number,
): FactorTone {
  if (value >= strongThreshold || value > positiveThreshold) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

function isWinOutcome(outcome: string): boolean {
  return outcome === "won" || outcome === "half_won";
}

function isLossOutcome(outcome: string): boolean {
  return outcome === "lost" || outcome === "half_lost";
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${round1(n).toFixed(1)}%`;
}

function formatPoints(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${round1(n).toFixed(1)} points`;
}

function formatProbability(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${round1(n).toFixed(1)}%`;
}

function formatUnits(n: number): string {
  return `${n >= 0 ? "+" : ""}${round1(n).toFixed(1)}u`;
}

function formatCents(n: number): string {
  return `${Math.round(n * 100)}c`;
}

function formatMultiplier(n: number): string {
  return `${round2(n).toFixed(2)}x`;
}

function round0(n: number): number {
  return Math.round(n);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
