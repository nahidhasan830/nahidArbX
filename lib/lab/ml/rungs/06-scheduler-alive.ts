import type { RungDefinition } from "./types";

const STALE_TICK_MS = 5 * 60 * 1000;

export const rung06SchedulerAlive: RungDefinition = {
  id: "scheduler_alive",
  number: 6,
  category: "training",
  title: "Auto-retrain scheduler is alive",
  evaluate: (d) => {
    const s = d.scheduler;
    if (!s.active) {
      return {
        status: "fail",
        primary: "stopped",
        secondary:
          "engine is not running, so the auto-retrain scheduler can't fire.",
        action: "Start or restart the engine on the Bangladesh machine.",
      };
    }

    if (s.lastTickAt == null) {
      return {
        status: "warn",
        primary: "no ticks yet",
        secondary: "scheduler started but hasn't completed its first tick.",
        action:
          "Wait about a minute, then restart the engine if it stays stuck.",
      };
    }

    const age = Date.now() - s.lastTickAt;
    if (age > STALE_TICK_MS) {
      const ageMin = Math.round(age / 60_000);
      return {
        status: "fail",
        primary: `${ageMin} min stale`,
        secondary:
          "scheduler is registered but hasn't ticked in too long — it may be deadlocked.",
        action:
          "Restart the engine if it does not recover on the next refresh.",
      };
    }

    const ageSec = Math.round(age / 1000);
    return {
      status: "pass",
      primary: `${ageSec}s ago`,
      secondary: `last tick was ${ageSec}s ago. ${s.totalRetrainTriggers} retrain trigger${s.totalRetrainTriggers === 1 ? "" : "s"} since boot.`,
    };
  },
  inputs: (d) => [
    { label: "active", value: String(d.scheduler.active) },
    {
      label: "lastTickAt",
      value:
        d.scheduler.lastTickAt == null
          ? "null"
          : new Date(d.scheduler.lastTickAt).toISOString(),
    },
    {
      label: "totalRetrainTriggers",
      value: String(d.scheduler.totalRetrainTriggers),
    },
    {
      label: "retrainStep",
      value: d.scheduler.retrainStep.toLocaleString(),
    },
  ],
  evidence: {
    why: "Auto-retrain only happens inside the scheduler tick. A dead scheduler means new corpus rows never trigger a fresh model.",
  },
};
