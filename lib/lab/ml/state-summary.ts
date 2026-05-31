import type { PipelineData } from "@/components/lab/ml/types";
import type { EvaluatedRung } from "./rungs";

/**
 * Build the one-sentence "what's happening right now" summary for the
 * page header. The summary picks the first failing or pending rung
 * after the data-collection block and weaves in a fact from the data.
 *
 * Output is intentionally short — the ladder below carries the detail.
 */
export function buildStateSummary(
  data: PipelineData,
  rungs: EvaluatedRung[],
): { headline: string; mood: "good" | "warn" | "bad" } {
  const deployed = data.training.deployedModel as {
    version: number;
    trainingSamples: number;
  } | null;
  const inTraining = data.training.modelsInTraining;

  // Find the first rung that's not green and not blocked.
  const firstIssue = rungs.find(
    (r) => r.verdict.status === "fail" || r.verdict.status === "warn",
  );

  if (firstIssue && firstIssue.verdict.status === "fail") {
    return {
      mood: "bad",
      headline:
        `Pipeline halted at rung ${firstIssue.definition.number} (${firstIssue.definition.title.toLowerCase()}). ${firstIssue.verdict.action ?? firstIssue.verdict.secondary ?? ""}`.trim(),
    };
  }

  if (inTraining > 0) {
    const corpus = data.dataCollection.qualifiedForTraining.toLocaleString();
    return {
      mood: "good",
      headline: `Training run in progress on a ${corpus}-example corpus. The dashboard will refresh when it lands.`,
    };
  }

  if (deployed) {
    const newSinceDeploy = data.training.newDataSinceLastTrain;
    const step = data.training.retrainStep;
    const sufficient = newSinceDeploy >= step;
    if (sufficient) {
      return {
        mood: "good",
        headline: `v${deployed.version} deployed. ${newSinceDeploy.toLocaleString()} new examples since deploy — auto-retrain queued.`,
      };
    }
    return {
      mood: "good",
      headline: `v${deployed.version} deployed on ${deployed.trainingSamples.toLocaleString()} samples. ${(step - newSinceDeploy).toLocaleString()} more examples until the next auto-retrain.`,
    };
  }

  // No deployed model yet; report the cold-start picture.
  const have = data.dataCollection.qualifiedForTraining;
  const need = data.dataCollection.coldStartThreshold;
  if (have >= need) {
    const multiple = (have / need).toFixed(1);
    if (firstIssue) {
      return {
        mood: "warn",
        headline: `No model deployed yet. Corpus is ${multiple}× past cold-start, but rung ${firstIssue.definition.number} (${firstIssue.definition.title.toLowerCase()}) is holding the next training run.`,
      };
    }
    return {
      mood: "good",
      headline: `No model deployed yet. ${have.toLocaleString()} training examples — ${multiple}× past cold-start. Auto-retrain fires on the next scheduler tick.`,
    };
  }

  return {
    mood: "warn",
    headline: `No model deployed yet. Corpus has ${have.toLocaleString()} of ${need.toLocaleString()} examples needed for cold-start (${need - have} to go).`,
  };
}
