import type { RungDefinition } from "./types";

export const rung08TrainingCompleted: RungDefinition = {
  id: "training_completed",
  number: 8,
  category: "training",
  title: "A training run completed",
  evaluate: (d) => {
    const history = d.modelHistory ?? [];
    const succeeded = history.find(
      (m) =>
        m.status === "deployed" ||
        m.status === "rejected" ||
        m.status === "validated",
    );
    const lastFailed = history.find((m) => m.status === "failed");

    if (succeeded) {
      const label =
        succeeded.status === "deployed" ? "deployed" : succeeded.status;
      return {
        status: "pass",
        primary: `v${succeeded.version}`,
        secondary: `most recent terminal run ${label} on ${succeeded.trainingSamples.toLocaleString()} samples.`,
      };
    }

    if (lastFailed) {
      const reason = lastFailed.rejectionReasons?.[0] ?? "unknown";
      return {
        status: "fail",
        primary: `v${lastFailed.version} failed`,
        secondary: `latest run rejected: ${reason}.`,
        action:
          "Open rung ⑨ and the engine logs to see the deployment-gate verdict in detail.",
      };
    }

    return {
      status: "pending",
      primary: "no runs yet",
      secondary: "no training run has ever completed against this corpus.",
    };
  },
  inputs: (d) => {
    const history = d.modelHistory ?? [];
    return [
      { label: "totalModelRows", value: String(history.length) },
      {
        label: "deployedRows",
        value: String(history.filter((m) => m.status === "deployed").length),
      },
      {
        label: "validatedRows",
        value: String(history.filter((m) => m.status === "validated").length),
      },
      {
        label: "rejectedRows",
        value: String(history.filter((m) => m.status === "rejected").length),
      },
      {
        label: "failedRows",
        value: String(history.filter((m) => m.status === "failed").length),
      },
    ];
  },
  evidence: {
    assertion: "modelHistory contains at least one row with status ≠ 'failed'",
    sourceFile: "app/api/ml/pipeline/route.ts:802",
    why: "If every run fails, the pipeline never produces a model — every downstream rung is stuck.",
    sql: `SELECT version, status, training_samples, created_at,
  rejection_reasons::text
FROM ml_models
ORDER BY created_at DESC
LIMIT 10;`,
  },
};
