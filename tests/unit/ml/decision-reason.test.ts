import { describe, expect, it } from "vitest";
import { buildDecisionReason } from "@/lib/ml/decision-reason";
import { FEATURE_COUNT, FEATURE_INDEX } from "@/lib/ml/feature-contract";

function makeFeatures(
  overrides: Partial<Record<number, number>> = {},
): number[] {
  const f = new Array(FEATURE_COUNT).fill(0);
  f[FEATURE_INDEX.sharp_true_prob] = 0.5;
  f[FEATURE_INDEX.soft_odds] = 2.15;
  f[FEATURE_INDEX.adjusted_soft_odds] = 2.15;
  f[FEATURE_INDEX.tick_count] = 5;
  for (const [idx, val] of Object.entries(overrides)) {
    f[Number(idx)] = val;
  }
  return f;
}

const IDX_SOFT_ODDS = FEATURE_INDEX.soft_odds;
const IDX_ADJUSTED_SOFT_ODDS = FEATURE_INDEX.adjusted_soft_odds;
const IDX_TICK_COUNT = FEATURE_INDEX.tick_count;
const IDX_STEAM_SHARP = FEATURE_INDEX.steam_move_sharp;
const IDX_CONVERGENCE = FEATURE_INDEX.convergence_rate;

describe("buildDecisionReason", () => {
  describe("skip case", () => {
    it("returns skip decision with negative edge in technical", () => {
      const result = buildDecisionReason(0.45, makeFeatures(), 0);
      expect(result.decision).toBe("skip");
      expect(result.multiplier).toBe(0);
      expect(result.multiplierChain).toBe("Edge ≤ 0% → skip (0×)");

      const edgeTech = result.technical.find((f) => f.label === "Model Edge");
      expect(edgeTech).toBeDefined();
      expect(edgeTech!.tone).toBe("negative");
    });

    it("mentions expected loss in explanation", () => {
      const result = buildDecisionReason(0.45, makeFeatures(), 0);
      const combined = result.explanation.map((p) => p.text).join(" ");
      expect(combined).toContain("break even");
    });
  });

  describe("boost case with steam + persistence", () => {
    it("includes Edge, Score, Steam, Persistence in technical with positive tones", () => {
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const result = buildDecisionReason(0.95, features, 1.87);
      expect(result.decision).toBe("boost");

      const edgeTech = result.technical.find((f) => f.label === "Model Edge");
      expect(edgeTech).toBeDefined();
      expect(edgeTech!.tone).toBe("positive");

      const steamTech = result.technical.find((f) => f.label === "Steam");
      expect(steamTech).toBeDefined();
      expect(steamTech!.tone).toBe("positive");
      expect(steamTech!.value).toContain("Sharp");

      const persistenceTech = result.technical.find(
        (f) => f.label === "Persistence",
      );
      expect(persistenceTech).toBeDefined();
      expect(persistenceTech!.tone).toBe("positive");
      expect(persistenceTech!.value).toContain("20");
    });

    it("mentions steam and persistence in explanation", () => {
      const features = makeFeatures({
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const result = buildDecisionReason(0.95, features, 1.87);
      const combined = result.explanation
        .map((p) => p.text)
        .join(" ")
        .toLowerCase();
      expect(combined).toContain("pinnacle");
      expect(combined).toContain("persist");
    });
  });

  describe("pure-shrink case (negative convergence, no steam)", () => {
    it("explanation mentions closing and technical shows convergence negative", () => {
      const features = makeFeatures({ [IDX_CONVERGENCE]: -0.5 });
      const result = buildDecisionReason(0.55, features, 0.8);
      expect(result.decision).toBe("shrink");

      const combined = result.explanation
        .map((p) => p.text)
        .join(" ")
        .toLowerCase();
      expect(combined).toContain("closing");

      const convTech = result.technical.find((f) => f.label === "Convergence");
      expect(convTech).toBeDefined();
      expect(convTech!.tone).toBe("negative");
      expect(convTech!.value).toContain("penalty");
    });

    it("does not include Steam in technical when inactive", () => {
      const features = makeFeatures({ [IDX_CONVERGENCE]: -0.5 });
      const result = buildDecisionReason(0.55, features, 0.8);
      const steamTech = result.technical.find((f) => f.label === "Steam");
      expect(steamTech).toBeUndefined();
    });
  });

  describe("agree case", () => {
    it("explanation mentions baseline value and Steam not in technical", () => {
      const features = makeFeatures();
      const result = buildDecisionReason(0.55, features, 1.0);
      expect(result.decision).toBe("agree");

      const combined = result.explanation
        .map((p) => p.text)
        .join(" ")
        .toLowerCase();
      expect(combined).toContain("value");
      expect(combined).toContain("no risk factors");

      const steamTech = result.technical.find((f) => f.label === "Steam");
      expect(steamTech).toBeUndefined();
      const persistenceTech = result.technical.find(
        (f) => f.label === "Persistence",
      );
      expect(persistenceTech).toBeDefined();
      expect(persistenceTech!.tone).toBe("neutral");
      expect(persistenceTech!.value).toContain("no bonus");
    });
  });

  describe("technical tones", () => {
    it("renders Score as negative when mlScore <= 0.4", () => {
      const result = buildDecisionReason(0.35, makeFeatures(), 1.0);
      const scoreTech = result.technical.find((f) => f.label === "Score");
      expect(scoreTech).toBeDefined();
      expect(scoreTech!.tone).toBe("negative");
      expect(scoreTech!.value).toContain("Low");
    });

    it("renders Score as positive when mlScore >= 0.6", () => {
      const result = buildDecisionReason(0.75, makeFeatures(), 1.0);
      const scoreTech = result.technical.find((f) => f.label === "Score");
      expect(scoreTech).toBeDefined();
      expect(scoreTech!.tone).toBe("positive");
      expect(scoreTech!.value).toContain("High");
    });

    it("omits Steam in technical when steam_move_sharp = 0", () => {
      const result = buildDecisionReason(
        0.55,
        makeFeatures({ [IDX_STEAM_SHARP]: 0 }),
        0.85,
      );
      const steamTech = result.technical.find((f) => f.label === "Steam");
      expect(steamTech).toBeUndefined();
    });

    it("shows Persistence as neutral when tick_count <= 10", () => {
      const result = buildDecisionReason(
        0.55,
        makeFeatures({ [IDX_TICK_COUNT]: 10 }),
        1.5,
      );
      const persistenceTech = result.technical.find(
        (f) => f.label === "Persistence",
      );
      expect(persistenceTech).toBeDefined();
      expect(persistenceTech!.tone).toBe("neutral");
      expect(persistenceTech!.value).toContain("no bonus");
    });

    it("renders Convergence as Stable when >= 0", () => {
      const result = buildDecisionReason(
        0.55,
        makeFeatures({ [IDX_CONVERGENCE]: 0.1 }),
        1.0,
      );
      const convTech = result.technical.find((f) => f.label === "Convergence");
      expect(convTech!.value).toContain("Stable");
      expect(convTech!.tone).toBe("neutral");
    });
  });

  describe("similar context", () => {
    it("includes similar section when context has >= 3 resolved bets", () => {
      const result = buildDecisionReason(0.55, makeFeatures(), 1.0, {
        decision: "agree",
        driver: "no_signal",
        driverLabel: "No clear signal agrees",
        recentWins: 4,
        recentLosses: 1,
        recentTotal: 5,
        unitPnl: 2.5,
      });
      expect(result.similar).toBeDefined();
      expect(result.similar!.driverLabel).toBe("No clear signal agrees");
      expect(result.similar!.wins).toBe(4);
      expect(result.similar!.text).toContain("4 of last 5");
      expect(result.similar!.pnlText).toBe("P&L +2.5u");
    });

    it("omits similar section when total < 3", () => {
      const result = buildDecisionReason(0.55, makeFeatures(), 1.0, {
        decision: "agree",
        driver: "no_signal",
        driverLabel: "No clear signal agrees",
        recentWins: 1,
        recentLosses: 1,
        recentTotal: 2,
        unitPnl: 0,
      });
      expect(result.similar).toBeUndefined();
    });

    it("omits similar section when context is null", () => {
      expect(buildDecisionReason(0.55, makeFeatures(), 1.0, null).similar).toBe(
        undefined,
      );
    });

    it("omits similar section when context is undefined", () => {
      expect(buildDecisionReason(0.55, makeFeatures(), 1.0).similar).toBe(
        undefined,
      );
    });
  });

  describe("multiplier chain", () => {
    it("shows full chain for boosted decisions", () => {
      const features = makeFeatures({
        [FEATURE_INDEX.sharp_true_prob]: 0.95,
        [IDX_TICK_COUNT]: 20,
        [IDX_STEAM_SHARP]: 5,
      });
      const result = buildDecisionReason(0.95, features, 1.87);
      expect(result.multiplierChain).toContain("×");
      expect(result.multiplierChain).toContain("2.34");
    });

    it("shows no adjustments when all factors are at 1.0", () => {
      const features = makeFeatures({ [IDX_TICK_COUNT]: 5 });
      features[IDX_SOFT_ODDS] = 2.1;
      features[IDX_ADJUSTED_SOFT_ODDS] = 2.1;
      const result = buildDecisionReason(0.5, features, 1.0);
      expect(result.multiplierChain).toContain("no adjustments");
    });
  });
});
