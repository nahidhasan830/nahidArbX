import { describe, expect, it } from "vitest";
import {
  evaluateRungs,
  formatRungNumber,
  RUNG_REGISTRY,
} from "@/lib/lab/ml/rungs";
import { rung01FeatureExtraction } from "@/lib/lab/ml/rungs/01-feature-extraction";
import { rung02FeatureContract } from "@/lib/lab/ml/rungs/02-feature-contract";
import { rung03TierEnrichment } from "@/lib/lab/ml/rungs/03-tier-enrichment";
import { rung04CorpusCoverage } from "@/lib/lab/ml/rungs/04-corpus-coverage";
import { rung05ColdStart } from "@/lib/lab/ml/rungs/05-cold-start";
import { rung06SchedulerAlive } from "@/lib/lab/ml/rungs/06-scheduler-alive";
import { rung07SchedulerReady } from "@/lib/lab/ml/rungs/07-scheduler-ready";
import { rung08TrainingCompleted } from "@/lib/lab/ml/rungs/08-training-completed";
import { rung09DeploymentGate } from "@/lib/lab/ml/rungs/09-deployment-gate";
import { rung10InferenceReachable } from "@/lib/lab/ml/rungs/10-inference-reachable";
import { rung11ScoreQuality } from "@/lib/lab/ml/rungs/11-score-quality";
import { rung12BeatsBaseline } from "@/lib/lab/ml/rungs/12-beats-baseline";
import { rung13PilotUnlocked } from "@/lib/lab/ml/rungs/13-pilot-unlocked";
import type { PipelineData } from "@/components/lab/ml/types";

/**
 * Synthetic baseline that passes every rung. Each test mutates the field
 * relevant to the rung under test.
 */
function makePassingData(): PipelineData {
  return {
    dataCollection: {
      totalBets: 5000,
      betsWithFeatures: 4900,
      settledWithFeatures: 4821,
      qualifiedForTraining: 4821,
      canonicalExamples: 4821,
      uncoveredQualifiedBets: 0,
      coldStartThreshold: 200,
      coldStartProgress: 100,
      featureExtractionHealthy: true,
      recentFeatureRate: 92,
      currentCorpus: {
        totalSettled: 4870,
        currentContractFeatures: 4821,
        wins: 2244,
        losses: 2626,
        coldStartThreshold: 200,
        collectionTarget: 500,
        remainingToColdStart: 0,
        remainingToTarget: 0,
      },
    },
    training: {
      totalModels: 1,
      deployedModel: {
        version: 1,
        trainingSamples: 4821,
        permissionLevel: "stake_increase",
      },
      latestModel: { version: 1, status: "deployed" },
      modelsInTraining: 0,
      readyToRetrain: false,
      newDataSinceLastTrain: 0,
      examplesUntilRetrain: 200,
      retrainStep: 200,
      activeTraining: null,
    },
    inference: {
      modelLoaded: true,
      modelVersion: 1,
      totalScoringAttempts: 200,
      totalScored: 200,
      avgInferenceMs: 42,
    },
    scheduler: {
      active: true,
      lastTickAt: Date.now() - 30_000,
      totalRetrainTriggers: 1,
      retrainStep: 200,
    },
    deploymentGate: {
      permissionLevel: "stake_increase",
      policyEdgeThresholdPct: 1.5,
      modelVersion: 1,
      canGate: true,
      canReduceStake: true,
      canIncreaseStake: true,
      lastRefreshedAt: new Date().toISOString(),
    },
    scoringMode: "Stake Adjust (full ML sizing)",
    featureContract: {
      currentVersion: 1,
      currentFeatureCount: 22,
      versionDistribution: [{ version: 1, count: 4821 }],
      lengthDistribution: [{ length: 22, count: 4821 }],
      allVersionsMatch: true,
      allLengthsMatch: true,
      semanticChecks: {
        betsWithCurrentFeatures: 4821,
        badCompetitionTier: 0,
        trainableSettledCurrentFeatures: 4821,
        badTrainableCompetitionTier: 0,
        labeledExamples: 4821,
        badLabeledCompetitionTier: 0,
        cleanLabeledExamples: 4821,
        badLabeledNonPositiveEv: 0,
        semanticPass: true,
      },
      allSemanticChecksPass: true,
      recentTierHealth: {
        windowHours: 24,
        betsWithFeatures: 200,
        betsWithValidTier: 200,
        validTierPct: 100,
        healthy: true,
      },
    },
    scoreBucketROI: [
      { bucket: "≤0%", count: 100, avgPnl: -2.0, avgClv: -1, winRate: 40 },
      { bucket: "0–2%", count: 80, avgPnl: 0.5, avgClv: 0.2, winRate: 48 },
      { bucket: "2–5%", count: 60, avgPnl: 2.0, avgClv: 1.0, winRate: 52 },
      { bucket: "5–10%", count: 40, avgPnl: 4.5, avgClv: 2.5, winRate: 56 },
      { bucket: "10–20%", count: 25, avgPnl: 7.0, avgClv: 4.0, winRate: 60 },
      { bucket: "≥20%", count: 10, avgPnl: 10.5, avgClv: 6.0, winRate: 65 },
    ],
    paperEvaluation: {
      semanticHealth: {
        betsWithCurrentFeatures: 4821,
        badCompetitionTier: 0,
        trainableSettledCurrentFeatures: 4821,
        badTrainableCompetitionTier: 0,
        labeledExamples: 4821,
        badLabeledCompetitionTier: 0,
        cleanLabeledExamples: 4821,
        badLabeledNonPositiveEv: 0,
        semanticPass: true,
      },
      simpleRule: { minEvPct: 3, marketTypes: ["ASIAN_HANDICAP", "MATCH_RESULT"] },
      mlMinScore: 0.4,
      mlModelEdgeThresholdPct: 1.5,
      metrics: {
        detectedBaseline: {
          label: "Detection Baseline",
          sampleSize: 4821,
          roiPct: 1.0,
          winRatePct: 50,
          avgEvPct: 3.5,
          avgOdds: 1.95,
        },
        simpleEvCore: {
          label: "Simple EV Rule",
          sampleSize: 1200,
          roiPct: 2.5,
          winRatePct: 53,
          avgEvPct: 5.0,
          avgOdds: 1.9,
        },
        mlScored: {
          label: "Model Scored",
          sampleSize: 4821,
          roiPct: 1.5,
          winRatePct: 51,
          avgEvPct: 4.0,
          avgOdds: 1.92,
        },
        mlGate: {
          label: "Model Gate",
          sampleSize: 800,
          roiPct: 4.5,
          winRatePct: 56,
          avgEvPct: 6.0,
          avgOdds: 1.88,
        },
      },
      verdict: {
        enoughMlGateSamples: true,
        mlBeatsSimpleRule: true,
        mlMinusSimpleRoiPct: 2.0,
      },
      trend: [],
    },
    rejectedModels: [],
    modelHistory: [
      {
        version: 1,
        status: "deployed",
        trainingSamples: 4821,
        oosAucRoc: 0.65,
        deflatedSharpe: 0.7,
        pbo: 0,
        permissionLevel: "stake_increase",
        rejectionReasons: null,
        deployedAt: new Date(Date.now() - 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ],
  };
}

describe("ML pipeline ladder rungs", () => {
  it("registry order is the file-name order", () => {
    expect(RUNG_REGISTRY.map((r) => r.id)).toEqual([
      "feature_extraction",
      "feature_contract",
      "tier_enrichment",
      "corpus_coverage",
      "cold_start",
      "scheduler_alive",
      "scheduler_ready",
      "training_completed",
      "deployment_gate",
      "inference_reachable",
      "score_quality",
      "beats_baseline",
      "pilot_unlocked",
    ]);
  });

  it("registry rung numbers are 1..13", () => {
    expect(RUNG_REGISTRY.map((r) => r.number)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
  });

  it("all green baseline produces 13 pass verdicts", () => {
    const verdicts = evaluateRungs(makePassingData()).map((r) => r.verdict.status);
    expect(verdicts).toEqual(Array(13).fill("pass"));
  });

  describe("rung 01 — feature extraction", () => {
    it("passes ≥80%", () => {
      const d = makePassingData();
      d.dataCollection.recentFeatureRate = 90;
      expect(rung01FeatureExtraction.evaluate(d).status).toBe("pass");
    });
    it("warns 50–79%", () => {
      const d = makePassingData();
      d.dataCollection.recentFeatureRate = 60;
      expect(rung01FeatureExtraction.evaluate(d).status).toBe("warn");
    });
    it("fails <50%", () => {
      const d = makePassingData();
      d.dataCollection.recentFeatureRate = 30;
      expect(rung01FeatureExtraction.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 02 — feature contract", () => {
    it("warns when versions diverge", () => {
      const d = makePassingData();
      d.featureContract.allVersionsMatch = false;
      d.featureContract.versionDistribution = [
        { version: 1, count: 4821 },
        { version: 3, count: 45 },
      ];
      expect(rung02FeatureContract.evaluate(d).status).toBe("warn");
    });
    it("fails when semantic check breaks", () => {
      const d = makePassingData();
      d.featureContract.allSemanticChecksPass = false;
      d.featureContract.semanticChecks.badCompetitionTier = 12;
      expect(rung02FeatureContract.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 03 — tier enrichment", () => {
    it("pending when zero traffic in window", () => {
      const d = makePassingData();
      d.featureContract.recentTierHealth!.betsWithFeatures = 0;
      expect(rung03TierEnrichment.evaluate(d).status).toBe("pending");
    });
    it("fails when validTierPct < 80", () => {
      const d = makePassingData();
      d.featureContract.recentTierHealth = {
        windowHours: 24,
        betsWithFeatures: 100,
        betsWithValidTier: 50,
        validTierPct: 50,
        healthy: false,
      };
      expect(rung03TierEnrichment.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 04 — corpus coverage", () => {
    it("warns when uncovered > 0", () => {
      const d = makePassingData();
      d.dataCollection.uncoveredQualifiedBets = 17;
      expect(rung04CorpusCoverage.evaluate(d).status).toBe("warn");
    });
  });

  describe("rung 05 — cold start", () => {
    it("fails below threshold", () => {
      const d = makePassingData();
      d.dataCollection.qualifiedForTraining = 50;
      expect(rung05ColdStart.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 06 — scheduler alive", () => {
    it("fails when scheduler is stopped", () => {
      const d = makePassingData();
      d.scheduler.active = false;
      d.scheduler.lastTickAt = null;
      expect(rung06SchedulerAlive.evaluate(d).status).toBe("fail");
    });
    it("warns when active but no tick yet", () => {
      const d = makePassingData();
      d.scheduler.lastTickAt = null;
      expect(rung06SchedulerAlive.evaluate(d).status).toBe("warn");
    });
    it("fails when last tick is stale", () => {
      const d = makePassingData();
      d.scheduler.lastTickAt = Date.now() - 30 * 60_000;
      expect(rung06SchedulerAlive.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 07 — scheduler ready", () => {
    it("pending when no deployed model yet and below cold-start retrain step", () => {
      const d = makePassingData();
      d.training.deployedModel = null;
      d.training.modelsInTraining = 0;
      d.training.readyToRetrain = false;
      d.training.newDataSinceLastTrain = 50;
      expect(rung07SchedulerReady.evaluate(d).status).toBe("pending");
    });
    it("passes when training is in progress", () => {
      const d = makePassingData();
      d.training.modelsInTraining = 1;
      expect(rung07SchedulerReady.evaluate(d).status).toBe("pass");
    });
    it("passes when idle and counting up under a deployed model", () => {
      const d = makePassingData();
      d.training.modelsInTraining = 0;
      d.training.readyToRetrain = false;
      d.training.newDataSinceLastTrain = 50;
      // Deployed model is intact from the baseline.
      expect(rung07SchedulerReady.evaluate(d).status).toBe("pass");
    });
  });

  describe("rung 08 — training completed", () => {
    it("pending when modelHistory is empty", () => {
      const d = makePassingData();
      d.modelHistory = [];
      expect(rung08TrainingCompleted.evaluate(d).status).toBe("pending");
    });
    it("fails when only failed runs exist", () => {
      const d = makePassingData();
      d.modelHistory = [
        {
          version: 0,
          status: "failed",
          trainingSamples: 0,
          oosAucRoc: null,
          deflatedSharpe: null,
          pbo: null,
          permissionLevel: null,
          rejectionReasons: ["Cold start: 0 samples, need 200"],
          deployedAt: null,
          createdAt: new Date().toISOString(),
        },
      ];
      expect(rung08TrainingCompleted.evaluate(d).status).toBe("fail");
    });
  });

  describe("rung 09 — deployment gate", () => {
    it("pending when no deployed model", () => {
      const d = makePassingData();
      d.training.deployedModel = null;
      d.rejectedModels = [];
      expect(rung09DeploymentGate.evaluate(d).status).toBe("pending");
    });
  });

  describe("rung 10 — inference reachable", () => {
    it("fails when modelLoaded is false", () => {
      const d = makePassingData();
      d.inference.modelLoaded = false;
      expect(rung10InferenceReachable.evaluate(d).status).toBe("fail");
    });
    it("warns when success rate is below 95%", () => {
      const d = makePassingData();
      d.inference.totalScoringAttempts = 100;
      d.inference.totalScored = 80;
      expect(rung10InferenceReachable.evaluate(d).status).toBe("warn");
    });
  });

  describe("rung 11 — score quality", () => {
    it("warns when ROI is non-monotonic", () => {
      const d = makePassingData();
      d.scoreBucketROI = [
        { bucket: "≤0%", count: 50, avgPnl: 5, avgClv: 0, winRate: 50 },
        { bucket: "≥20%", count: 50, avgPnl: -1, avgClv: 0, winRate: 50 },
      ];
      expect(rung11ScoreQuality.evaluate(d).status).toBe("warn");
    });
  });

  describe("rung 12 — beats baseline", () => {
    it("pending when fewer than 100 ML-gate samples", () => {
      const d = makePassingData();
      d.paperEvaluation.metrics.mlGate.sampleSize = 40;
      d.paperEvaluation.verdict.enoughMlGateSamples = false;
      expect(rung12BeatsBaseline.evaluate(d).status).toBe("pending");
    });
    it("warns when ML doesn't beat simple-EV", () => {
      const d = makePassingData();
      d.paperEvaluation.verdict.mlBeatsSimpleRule = false;
      d.paperEvaluation.verdict.mlMinusSimpleRoiPct = -1.2;
      expect(rung12BeatsBaseline.evaluate(d).status).toBe("warn");
    });
  });

  describe("rung 13 — pilot unlocked", () => {
    it("pending at observe", () => {
      const d = makePassingData();
      d.deploymentGate.permissionLevel = "observe";
      expect(rung13PilotUnlocked.evaluate(d).status).toBe("pending");
    });
    it("pending at gate_only", () => {
      const d = makePassingData();
      d.deploymentGate.permissionLevel = "gate_only";
      expect(rung13PilotUnlocked.evaluate(d).status).toBe("pending");
    });
  });

  describe("prerequisite blocking", () => {
    it("blocks downstream rungs when an upstream prereq fails", () => {
      const d = makePassingData();
      d.training.deployedModel = null;
      d.rejectedModels = [];
      const verdicts = evaluateRungs(d);
      const inferenceRung = verdicts.find(
        (r) => r.definition.id === "inference_reachable",
      );
      expect(inferenceRung?.verdict.status).toBe("blocked");
    });

    it("blocks score-quality + beats-baseline + pilot when inference is blocked", () => {
      const d = makePassingData();
      d.inference.modelLoaded = false;
      const verdicts = evaluateRungs(d);
      const ids = ["score_quality", "beats_baseline", "pilot_unlocked"];
      for (const id of ids) {
        const v = verdicts.find((r) => r.definition.id === id);
        expect(v?.verdict.status).toBe("blocked");
      }
    });
  });

  describe("inputs() coverage", () => {
    it("every rung defines an inputs() callback", () => {
      for (const def of RUNG_REGISTRY) {
        expect(typeof def.inputs).toBe("function");
      }
    });
    it("every inputs() returns ≥1 labelled value on the passing baseline", () => {
      const data = makePassingData();
      for (const def of RUNG_REGISTRY) {
        const rows = def.inputs!(data);
        expect(rows.length, `rung ${def.id} produced 0 inputs`).toBeGreaterThan(0);
        for (const row of rows) {
          expect(typeof row.label).toBe("string");
          expect(row.label.length).toBeGreaterThan(0);
          expect(typeof row.value).toBe("string");
        }
      }
    });
  });

  describe("evidence record completeness", () => {
    it("every rung's evidence explains why it matters", () => {
      for (const def of RUNG_REGISTRY) {
        expect(def.evidence.why.length).toBeGreaterThan(0);
      }
    });
  });

  describe("actions visibility", () => {
    it("retrain-now hides while a training run is in progress", () => {
      const def = RUNG_REGISTRY.find((r) => r.id === "scheduler_ready")!;
      const action = def.actions!.find((a) => a.id === "retrain_now")!;
      const data = makePassingData();
      data.training.modelsInTraining = 1;
      expect(action.visibleWhen!(data)).toBe(false);
      data.training.modelsInTraining = 0;
      expect(action.visibleWhen!(data)).toBe(true);
    });

    it("reconcile-now only shows when uncovered > 0", () => {
      const def = RUNG_REGISTRY.find((r) => r.id === "corpus_coverage")!;
      const action = def.actions!.find((a) => a.id === "reconcile_now")!;
      const data = makePassingData();
      data.dataCollection.uncoveredQualifiedBets = 0;
      expect(action.visibleWhen!(data)).toBe(false);
      data.dataCollection.uncoveredQualifiedBets = 7;
      expect(action.visibleWhen!(data)).toBe(true);
    });

    it("rollback hides when no other deployable model exists", () => {
      const def = RUNG_REGISTRY.find((r) => r.id === "deployment_gate")!;
      const action = def.actions!.find((a) => a.id === "rollback_previous")!;
      const data = makePassingData();
      // baseline: only one model in history (v1, deployed) — nothing to roll back to.
      expect(action.visibleWhen!(data)).toBe(false);
    });

    it("rollback shows when a previously-deployed retired version exists", () => {
      const def = RUNG_REGISTRY.find((r) => r.id === "deployment_gate")!;
      const action = def.actions!.find((a) => a.id === "rollback_previous")!;
      const data = makePassingData();
      data.modelHistory = [
        ...data.modelHistory,
        {
          version: 0, // ignored — version 0 doesn't show in modelHistory
          status: "rejected",
          trainingSamples: 0,
          oosAucRoc: null,
          deflatedSharpe: null,
          pbo: null,
          permissionLevel: null,
          rejectionReasons: null,
          deployedAt: null,
          createdAt: null,
        },
        {
          version: 0,
          status: "retired",
          trainingSamples: 4500,
          oosAucRoc: 0.62,
          deflatedSharpe: 0.65,
          pbo: 0,
          permissionLevel: "observe",
          rejectionReasons: null,
          deployedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      ];
      // Bump the retired sibling to a different version so the visibleWhen
      // check (version !== current) actually filters it.
      data.modelHistory[2] = { ...data.modelHistory[2], version: 99 };
      expect(action.visibleWhen!(data)).toBe(true);
      const body = action.body!(data);
      expect(body.targetVersion).toBe(99);
    });
  });

  describe("formatRungNumber", () => {
    it("renders 1..9 as circled digits", () => {
      expect(formatRungNumber(1)).toBe("①");
      expect(formatRungNumber(9)).toBe("⑨");
    });
    it("renders 10..13 as circled digits", () => {
      expect(formatRungNumber(10)).toBe("⑩");
      expect(formatRungNumber(13)).toBe("⑬");
    });
  });
});
