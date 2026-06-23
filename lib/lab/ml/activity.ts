import type { PipelineData } from "@/components/lab/ml/types";
import { formatPermissionLevel } from "./display";


export type ActivityKind =
  | "model_deployed"
  | "model_rejected"
  | "model_failed"
  | "training_started"
  | "scheduler_tick"
  | "permission_change";

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
}

export function synthesizeActivity(data: PipelineData): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const history = data.modelHistory ?? [];
  for (const m of history) {
    if (m.deployedAt) {
      events.push({
        id: `deploy-${m.version}`,
        at: m.deployedAt,
        kind: "model_deployed",
        title: `v${m.version} deployed`,
        detail: m.permissionLevel
          ? `Permission: ${formatPermissionLevel(m.permissionLevel)}`
          : undefined,
      });
    }
    if (m.status === "rejected" && m.createdAt) {
      const reason = m.rejectionReasons?.[0];
      events.push({
        id: `reject-${m.version}`,
        at: m.createdAt,
        kind: "model_rejected",
        title: `v${m.version} rejected`,
        detail: reason,
      });
    }
    if (m.status === "failed" && m.createdAt) {
      const reason = m.rejectionReasons?.[0];
      events.push({
        id: `fail-${m.version}`,
        at: m.createdAt,
        kind: "model_failed",
        title: `v${m.version} run failed`,
        detail: reason,
      });
    }
  }

  const active = data.training.activeTraining;
  if (active?.startedAt) {
    events.push({
      id: `train-${active.modelId}`,
      at: active.startedAt,
      kind: "training_started",
      title: `Training run v${active.version}`,
      detail: active.progressMessage ?? active.trainingStage ?? undefined,
    });
  }

  if (data.scheduler.lastTickAt) {
    events.push({
      id: `tick-${data.scheduler.lastTickAt}`,
      at: new Date(data.scheduler.lastTickAt).toISOString(),
      kind: "scheduler_tick",
      title: "Scheduler tick",
      detail:
        data.scheduler.totalRetrainTriggers > 0
          ? `${data.scheduler.totalRetrainTriggers} retrain triggers since boot`
          : undefined,
    });
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, 12);
}
