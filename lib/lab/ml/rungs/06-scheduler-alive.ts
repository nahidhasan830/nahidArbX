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
        action: "Start the engine: `npm run engine` from the Bangladesh box.",
      };
    }

    if (s.lastTickAt == null) {
      return {
        status: "warn",
        primary: "no ticks yet",
        secondary: "scheduler started but hasn't completed its first tick.",
        action:
          "Wait ~60s; if it stays this way the engine logs will show the cause.",
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
          "Check the engine logs. Restart the engine if no obvious error.",
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
      label: "lastError",
      value: d.scheduler.lastError ?? "null",
    },
    {
      label: "retrainStep",
      value: d.scheduler.retrainStep.toLocaleString(),
    },
  ],
  evidence: {
    assertion: "scheduler.active && (now - scheduler.lastTickAt) ≤ 5min",
    sourceFile: "lib/optimizer/scheduler.ts:tick",
    why: "Auto-retrain only happens inside the scheduler tick. A dead scheduler means new corpus rows never trigger a fresh model.",
  },
  actions: [
    {
      id: "start_engine_instructions",
      kind: "instruction",
      label: "Show start command",
      description:
        "The engine must run on the Bangladesh box (NineWickets/Velki are geo-restricted).",
      command: "npm run engine",
      visibleWhen: (d) => !d.scheduler.active,
    },
  ],
};
