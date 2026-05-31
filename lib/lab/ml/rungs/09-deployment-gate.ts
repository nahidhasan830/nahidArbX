import type { RungDefinition } from "./types";
import { formatPermissionLevel } from "../display";

export const rung09DeploymentGate: RungDefinition = {
  id: "deployment_gate",
  number: 9,
  category: "training",
  title: "Latest run cleared the deployment gate",
  prereqs: ["training_completed"],
  evaluate: (d) => {
    const deployed = d.training.deployedModel as {
      version: number;
      trainingSamples: number;
      permissionLevel: string | null;
    } | null;
    const rejected = d.rejectedModels?.[0];

    if (deployed) {
      const level = deployed.permissionLevel ?? "observe";
      return {
        status: "pass",
        primary: `v${deployed.version} @ ${formatPermissionLevel(level)}`,
        secondary: `deployed on ${deployed.trainingSamples.toLocaleString()} samples.`,
      };
    }

    if (rejected) {
      const reason = rejected.reasons?.[0] ?? "no reason recorded";
      return {
        status: "fail",
        primary: `v${rejected.version} rejected`,
        secondary: `gate rejected the latest model: ${reason}.`,
        action:
          "Review the rejection reasons and decide whether to retrain with more data.",
      };
    }

    return {
      status: "pending",
      primary: "no deployed model",
      secondary: "no model has ever cleared the deployment gate.",
    };
  },
  inputs: (d) => {
    const deployed = d.training.deployedModel as {
      version: number;
      trainingSamples: number;
      permissionLevel: string | null;
    } | null;
    const rejected = d.rejectedModels?.[0];
    const candidates = (d.modelHistory ?? []).filter(
      (m) => m.status === "validated" || m.status === "deployed",
    );
    const inputs = [
      {
        label: "deployedVersion",
        value: deployed ? `v${deployed.version}` : "—",
      },
      {
        label: "permissionLevel",
        value: deployed?.permissionLevel ?? "—",
      },
      {
        label: "rejectedRecent",
        value: rejected ? `v${rejected.version}` : "—",
      },
      {
        label: "rejectedReasons",
        value: rejected?.reasons?.join("; ") ?? "—",
      },
      {
        label: "candidateModels",
        value:
          candidates.map((m) => `v${m.version}/${m.status}`).join(", ") || "—",
      },
    ];
    return inputs;
  },
  evidence: {
    why: "A deployed model is the threshold that flips the pipeline from 'observing' to 'capable of affecting placement'.",
  },
  actions: [
    {
      id: "rollback_previous",
      label: "Roll back to previous deployed version",
      description:
        "Retire the current deployed model and re-deploy the most recent previously-deployed version.",
      intent: "destructive",
      confirm: {
        title: "Roll back deployed model",
        body: "This retires the current deployed model and re-deploys the most recent previously-deployed version. The live scorer usually picks up the change within about a minute.",
        confirmText: "Roll back",
      },
      method: "POST",
      endpoint: "/api/ml/rollback",
      body: (d) => {
        const history = d.modelHistory ?? [];
        const prev = history
          .filter((m) => m.status === "retired" || m.status === "deployed")
          .filter(
            (m) =>
              m.version !==
              (d.training.deployedModel as { version: number } | null)?.version,
          )[0];
        return { targetVersion: prev?.version };
      },
      visibleWhen: (d) => {
        const history = d.modelHistory ?? [];
        const previouslyDeployed = history.filter(
          (m) =>
            (m.status === "retired" || m.status === "deployed") &&
            m.version !==
              (d.training.deployedModel as { version: number } | null)?.version,
        );
        return (
          previouslyDeployed.length > 0 && d.training.deployedModel != null
        );
      },
    },
  ],
};
