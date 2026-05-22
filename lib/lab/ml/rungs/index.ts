/**
 * Pipeline ladder rung registry.
 *
 * The exported `RUNG_REGISTRY` is the single source of truth for the
 * ML Optimizer dashboard. Order matters — the array order is the
 * vertical reading order.
 */

import type { PipelineData } from "@/components/lab/ml/types";
import type { RungDefinition, RungVerdict } from "./types";

import { rung01FeatureExtraction } from "./01-feature-extraction";
import { rung02FeatureContract } from "./02-feature-contract";
import { rung03TierEnrichment } from "./03-tier-enrichment";
import { rung04CorpusCoverage } from "./04-corpus-coverage";
import { rung05ColdStart } from "./05-cold-start";
import { rung06SchedulerAlive } from "./06-scheduler-alive";
import { rung07SchedulerReady } from "./07-scheduler-ready";
import { rung08TrainingCompleted } from "./08-training-completed";
import { rung09DeploymentGate } from "./09-deployment-gate";
import { rung10InferenceReachable } from "./10-inference-reachable";
import { rung11ScoreQuality } from "./11-score-quality";
import { rung12BeatsBaseline } from "./12-beats-baseline";
import { rung13PilotUnlocked } from "./13-pilot-unlocked";

export const RUNG_REGISTRY: RungDefinition[] = [
  rung01FeatureExtraction,
  rung02FeatureContract,
  rung03TierEnrichment,
  rung04CorpusCoverage,
  rung05ColdStart,
  rung06SchedulerAlive,
  rung07SchedulerReady,
  rung08TrainingCompleted,
  rung09DeploymentGate,
  rung10InferenceReachable,
  rung11ScoreQuality,
  rung12BeatsBaseline,
  rung13PilotUnlocked,
];

export type {
  RungDefinition,
  RungVerdict,
  RungStatus,
  RungCategory,
  RungInput,
  RungEvidence,
  RungAction,
} from "./types";

export interface EvaluatedRung {
  definition: RungDefinition;
  verdict: RungVerdict;
}

/**
 * Evaluate every rung in order, applying prerequisite gating.
 *
 * If a rung's `prereqs` include any rung whose verdict is not `pass`,
 * the rung is reported as `blocked` regardless of what its evaluator
 * returns. This keeps attention focused on the first failure and avoids
 * cascading red verdicts down the ladder.
 */
export function evaluateRungs(data: PipelineData): EvaluatedRung[] {
  const result: EvaluatedRung[] = [];
  const verdictsById = new Map<string, RungVerdict>();

  for (const definition of RUNG_REGISTRY) {
    const blocking = (definition.prereqs ?? []).find(
      (id) => verdictsById.get(id)?.status !== "pass",
    );

    let verdict: RungVerdict;
    if (blocking) {
      const upstream = RUNG_REGISTRY.find((r) => r.id === blocking);
      const label = upstream
        ? `rung ${formatRungNumber(upstream.number)}`
        : `rung ${blocking}`;
      verdict = {
        status: "blocked",
        primary: "—",
        secondary: `Blocked by ${label}. Resolves automatically once that rung is green.`,
      };
    } else {
      verdict = definition.evaluate(data);
    }

    verdictsById.set(definition.id, verdict);
    result.push({ definition, verdict });
  }

  return result;
}

const CIRCLED_DIGITS = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

export function formatRungNumber(n: number): string {
  if (n >= 0 && n <= 9) return CIRCLED_DIGITS[n];
  if (n === 10) return "⑩";
  if (n === 11) return "⑪";
  if (n === 12) return "⑫";
  if (n === 13) return "⑬";
  return String(n);
}
