import type { RungDefinition } from "./types";

export const rung07SchedulerReady: RungDefinition = {
  id: "scheduler_ready",
  number: 7,
  category: "training",
  title: "Scheduler will fire when ready",
  prereqs: ["scheduler_alive"],
  evaluate: (d) => {
    const t = d.training;

    if (t.modelsInTraining > 0) {
      return {
        status: "pass",
        primary: "training in progress",
        secondary: `${t.modelsInTraining} run${t.modelsInTraining === 1 ? "" : "s"} active right now.`,
      };
    }

    if (t.readyToRetrain) {
      return {
        status: "pass",
        primary: "queued",
        secondary: t.deployedModel
          ? `${t.newDataSinceLastTrain.toLocaleString()} new examples since last deploy — auto-retrain triggers on the next tick.`
          : "no deployed model yet — first training fires on the next tick.",
      };
    }

    if (!t.deployedModel) {
      return {
        status: "pending",
        primary: `${t.newDataSinceLastTrain.toLocaleString()} / ${t.retrainStep.toLocaleString()}`,
        secondary: `${t.examplesUntilRetrain.toLocaleString()} more training examples until the next auto-retrain.`,
      };
    }

    return {
      status: "pass",
      primary: `${t.newDataSinceLastTrain.toLocaleString()} / ${t.retrainStep.toLocaleString()}`,
      secondary: `${t.examplesUntilRetrain.toLocaleString()} more training examples until the next auto-retrain.`,
    };
  },
  inputs: (d) => [
    {
      label: "modelsInTraining",
      value: String(d.training.modelsInTraining),
    },
    {
      label: "readyToRetrain",
      value: String(d.training.readyToRetrain),
    },
    {
      label: "newDataSinceLastTrain",
      value: d.training.newDataSinceLastTrain.toLocaleString(),
    },
    {
      label: "examplesUntilRetrain",
      value: d.training.examplesUntilRetrain.toLocaleString(),
    },
    {
      label: "retrainStep",
      value: d.training.retrainStep.toLocaleString(),
    },
  ],
  evidence: {
    why: "This rung tells you whether the corpus has crossed the auto-retrain threshold. When it shows queued, the next tick starts training.",
  },
  actions: [
    {
      id: "retrain_now",
      label: "Retrain now",
      description:
        "Manually trigger a training job. Missing examples are reconciled first.",
      method: "POST",
      endpoint: "/api/ml/retrain",
      visibleWhen: (d) => d.training.modelsInTraining === 0,
    },
  ],
};
