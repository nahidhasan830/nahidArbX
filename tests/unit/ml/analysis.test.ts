import { describe, expect, it } from "vitest";
import {
  buildAnalysis,
  buildTrackRecord,
  classifyEdgeTier,
  computeConfidence,
} from "@/lib/ml/analysis";
import type { SimilarBetRow } from "@/lib/ml/analysis-types";

function makeFeatures(overrides: Record<number, number> = {}): number[] {
  const f = new Array(25).fill(0);
  f[2] = 2.15;
  f[3] = 2.15;
  f[5] = 5;
  for (const [idx, value] of Object.entries(overrides)) {
    f[Number(idx)] = value;
  }
  return f;
}

const IDX_SOFT_ODDS = 2;
const IDX_ADJUSTED_SOFT_ODDS = 3;
const IDX_TICK_COUNT = 5;
const IDX_STEAM_SHARP = 9;
const IDX_CONVERGENCE = 13;

function similar(overrides: Partial<SimilarBetRow> = {}): SimilarBetRow {
  return {
    id: "bet-1",
    eventId: "event-1",
    homeTeam: "Home",
    awayTeam: "Away",
    competition: "Test League",
    eventStartTime: null,
    outcome: "lost",
    softOdds: 2,
    unitPnl: -1,
    unitPnlFormatted: "-1.00u",
    modelEdge: -20,
    modelEdgeFormatted: "-20.0%",
    firstSeenAt: "2026-05-01T00:00:00.000Z",
    marketType: "MATCH_RESULT",
    ...overrides,
  };
}

describe("analysis engine", () => {
  describe("edge tier classification", () => {
    it("classifies negative and positive model edges", () => {
      expect(classifyEdgeTier(-40)).toBe("negative_edge_deep");
      expect(classifyEdgeTier(-7)).toBe("negative_edge_moderate");
      expect(classifyEdgeTier(-2)).toBe("negative_edge_mild");
      expect(classifyEdgeTier(15)).toBe("positive_edge_deep");
    });
  });

  describe("confidence meter", () => {
    it("returns 5 stars for deep edge with steam and persistence", () => {
      const confidence = computeConfidence(18, ["steam", "persistence"]);
      expect(confidence.stars).toBe(5);
      expect(confidence.label).toBe("Excellent");
    });

    it("returns 1 star for mild negative edge", () => {
      const confidence = computeConfidence(-2, []);
      expect(confidence.stars).toBe(1);
      expect(confidence.reasons.join(" ")).toContain("Small negative edge");
    });

    it("penalizes shrink confidence when value is fading", () => {
      const confidence = computeConfidence(4, ["convergence_fading"]);
      expect(confidence.stars).toBe(1);
      expect(confidence.reasons.join(" ")).toContain("value is fading");
    });
  });

  describe("narrative builder", () => {
    it("generates a deep-negative skip story with dollar impact", () => {
      const analysis = buildAnalysis({
        bet: {
          id: "bet-skip",
          homeTeam: "CRB",
          awayTeam: "Fortaleza",
          competition: "Brazil - Cup",
          marketType: "ASIAN_HANDICAP",
          softOdds: 1.23,
          mlScore: 0.49,
        },
        features: makeFeatures({
          [IDX_SOFT_ODDS]: 1.23,
          [IDX_ADJUSTED_SOFT_ODDS]: 1.23,
        }),
        multiplier: 0,
        similarBets: [],
      });

      expect(analysis.decision.type).toBe("skip");
      expect(analysis.story.title).toBe("The Price Is Brutal");
      expect(analysis.story.dollarImpact?.perDollar).toBeLessThan(0);
      expect(analysis.numbers.modelEdge).toBeLessThan(-10);
    });

    it("generates a shrink story when positive value is fading", () => {
      const analysis = buildAnalysis({
        bet: {
          id: "bet-shrink",
          homeTeam: "Home",
          awayTeam: "Away",
          competition: "League",
          marketType: "MATCH_RESULT",
          softOdds: 2,
          mlScore: 0.52,
        },
        features: makeFeatures({
          [IDX_SOFT_ODDS]: 2,
          [IDX_ADJUSTED_SOFT_ODDS]: 2,
          [IDX_CONVERGENCE]: -0.25,
        }),
        multiplier: 0.6,
        similarBets: [],
      });

      expect(analysis.decision.type).toBe("shrink");
      expect(analysis.story.title).toBe("Value, But Fading");
      expect(analysis.numbers.factors.some((f) => f.name === "Convergence")).toBe(
        true,
      );
    });

    it("generates a deep boost story with 5-star confidence", () => {
      const analysis = buildAnalysis({
        bet: {
          id: "bet-boost",
          homeTeam: "Home",
          awayTeam: "Away",
          competition: "League",
          marketType: "MATCH_RESULT",
          softOdds: 2.15,
          mlScore: 0.65,
        },
        features: makeFeatures({
          [IDX_TICK_COUNT]: 15,
          [IDX_STEAM_SHARP]: 1,
        }),
        multiplier: 1.45,
        similarBets: [],
      });

      expect(analysis.decision.type).toBe("boost");
      expect(analysis.story.title).toBe("The Model Sees a Steal");
      expect(analysis.confidence.stars).toBe(5);
    });

    it("formats model score as probability without absolute low/high labels", () => {
      const analysis = buildAnalysis({
        bet: {
          id: "bet-draw",
          homeTeam: "Home",
          awayTeam: "Away",
          competition: "League",
          marketType: "MATCH_RESULT",
          softOdds: 4.4,
          mlScore: 0.252,
        },
        features: makeFeatures({
          [IDX_SOFT_ODDS]: 4.4,
          [IDX_ADJUSTED_SOFT_ODDS]: 4.4,
        }),
        multiplier: 1.8,
        similarBets: [],
      });

      expect(analysis.decision.type).toBe("boost");
      expect(analysis.numbers.modelScoreFormatted).toBe("25.2%");
    });

    it("keeps odds precision in the payload used with model edge", () => {
      const analysis = buildAnalysis({
        bet: {
          id: "bet-precision",
          homeTeam: "Home",
          awayTeam: "Away",
          competition: "League",
          marketType: "MATCH_RESULT",
          softOdds: 2.3837,
          mlScore: 0.4266,
        },
        features: makeFeatures({
          [IDX_SOFT_ODDS]: 2.3837,
          [IDX_ADJUSTED_SOFT_ODDS]: 2.3837,
        }),
        multiplier: 0.77,
        similarBets: [],
      });

      expect(analysis.numbers.odds).toBe(2.3837);
      expect(analysis.numbers.modelEdge).toBe(1.7);
    });
  });

  describe("track record", () => {
    it("returns a deep bucket with unprofitable warning", () => {
      const track = buildTrackRecord({
        bucket: "negative_edge_deep",
        decision: "skip",
        modelEdgePct: -40,
        similarBets: [
          similar({ id: "a", eventId: "a", outcome: "won", unitPnl: 0.8 }),
          similar({ id: "b", eventId: "b", outcome: "lost", unitPnl: -1 }),
          similar({ id: "c", eventId: "c", outcome: "lost", unitPnl: -1 }),
        ],
      });

      expect(track.bucketLabel).toBe("Deep Negative Edge Skips");
      expect(track.wins).toBe(1);
      expect(track.losses).toBe(2);
      expect(track.note).toContain("unprofitable");
    });

    it("explains variance for profitable mild-negative skips", () => {
      const track = buildTrackRecord({
        bucket: "negative_edge_mild",
        decision: "skip",
        modelEdgePct: -2,
        similarBets: [
          similar({ id: "a", eventId: "a", outcome: "won", unitPnl: 1.1 }),
          similar({ id: "b", eventId: "b", outcome: "won", unitPnl: 1.1 }),
          similar({ id: "c", eventId: "c", outcome: "lost", unitPnl: -1 }),
        ],
      });

      expect(track.unitPnl).toBeGreaterThan(0);
      expect(track.note).toContain("variance");
    });
  });
});
