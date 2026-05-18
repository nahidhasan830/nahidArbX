"use client";

/**
 * LiveTrainingPanel — live stage timeline, heartbeat details, and controls.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, OctagonX, RefreshCw, StopCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { MLTrainingUpdate } from "@/lib/events/event-bus";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE = {
  good: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  bad: "border-rose-500/40 bg-rose-500/10 text-rose-400",
  info: "border-cyan-500/40 bg-cyan-500/10 text-cyan-400",
  neutral: "border-white/[0.08] bg-white/[0.03] text-white/35",
} satisfies Record<Tone, string>;

const STAGES = [
  { key: "loading", label: "Load" },
  { key: "hpo", label: "HPO" },
  { key: "holdout", label: "Holdout" },
  { key: "cpcv", label: "CPCV" },
  { key: "final", label: "Final" },
  { key: "gate", label: "Gate" },
  { key: "export", label: "Export" },
  { key: "complete", label: "Done" },
] as const;

export function LiveTrainingPanel({
  training,
  log,
  isConnected,
  dataCount,
}: {
  training: MLTrainingUpdate;
  log: MLTrainingUpdate[];
  isConnected: boolean;
  dataCount: number;
}) {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const isTerminal = ["completed", "failed", "rejected"].includes(
    training.phase,
  );
  const baseElapsed = training.elapsedMs ?? 0;

  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => {
      setTick((v) => v + 1000);
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isTerminal]);

  const elapsed = baseElapsed + tick;
  const stage = training.stage ?? stageFromPhase(training.phase);
  const stageIndex = Math.max(
    0,
    STAGES.findIndex((s) => s.key === stage),
  );
  const heartbeatAgeMs = training.lastHeartbeatAt
    ? now - new Date(training.lastHeartbeatAt).getTime()
    : null;
  const tone: Tone =
    training.phase === "failed"
      ? "bad"
      : training.phase === "rejected"
        ? "warn"
        : training.phase === "completed"
          ? "good"
          : "info";

  const cancel = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/ml/training/${training.modelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cancel",
          reason: "Training cancelled by operator.",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Training row marked failed");
      void qc.invalidateQueries({ queryKey: ["ml"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    },
  });

  const retry = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ml/retrain", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Retry training started");
      void qc.invalidateQueries({ queryKey: ["ml"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    },
  });

  const logEntries = useMemo(() => {
    const bySignature = new Map<string, MLTrainingUpdate>();
    for (const entry of log) {
      const key = `${entry.modelId}|${entry.stage ?? entry.phase}|${entry.message}`;
      if (!bySignature.has(key)) bySignature.set(key, entry);
    }
    return [...bySignature.values()].slice(0, 6);
  }, [log]);

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2.5">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                TONE[tone],
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  tone === "bad"
                    ? "bg-rose-400"
                    : tone === "warn"
                      ? "bg-amber-400"
                      : tone === "good"
                        ? "bg-emerald-400"
                        : "bg-cyan-400",
                  !isTerminal && "animate-pulse",
                )}
              />
              Training v{training.version || "next"}
            </span>
            <span className="text-[11px] text-white/35">
              {isConnected ? "stream connected" : "stream reconnecting"}
            </span>
          </div>
          <p className="mt-1 truncate text-sm text-white/80">
            {training.message}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {!isTerminal && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                  className="h-7 border-rose-500/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/15"
                >
                  {cancel.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <StopCircle className="size-3" />
                  )}
                  Stop
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-sm">
                Mark this training row failed so the dashboard and scheduler
                stop treating it as active.
              </TooltipContent>
            </Tooltip>
          )}
          {isTerminal && training.phase !== "completed" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => retry.mutate()}
                  disabled={retry.isPending}
                  className="h-7 border-cyan-500/25 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/15"
                >
                  {retry.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  Retry
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-sm">
                Start a fresh Cloud Run training job using the current corpus.
              </TooltipContent>
            </Tooltip>
          )}
          {training.phase === "failed" && (
            <OctagonX className="size-4 text-rose-400" />
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <div className="grid grid-cols-4 gap-1.5 md:grid-cols-8">
            {STAGES.map((s, index) => {
              const state =
                training.phase === "failed" && index === stageIndex
                  ? "failed"
                  : index < stageIndex || isTerminal
                    ? "done"
                    : index === stageIndex
                      ? "current"
                      : "waiting";
              return <StageDot key={s.key} label={s.label} state={state} />;
            })}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-1.5 text-[11px] md:grid-cols-4">
            <Metric label="Elapsed" value={formatDuration(elapsed)} />
            <Metric
              label="Heartbeat"
              value={
                heartbeatAgeMs == null
                  ? "waiting"
                  : `${formatDuration(heartbeatAgeMs)} ago`
              }
            />
            <Metric
              label="ETA"
              value={
                training.estimatedRemainingMs
                  ? `~${formatDuration(training.estimatedRemainingMs)}`
                  : "—"
              }
            />
            <Metric label="Examples" value={dataCount.toLocaleString()} />
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-white/[0.05] bg-black/15 px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-white/45">
              Live log
            </span>
            <span className="text-[10px] text-white/25">
              {logEntries.length} events
            </span>
          </div>
          <div className="space-y-1">
            {logEntries.length > 0 ? (
              logEntries.map((entry, index) => (
                <p
                  key={`${entry.modelId}-${entry.updatedAt}-${index}`}
                  className="grid grid-cols-[64px_58px_minmax(0,1fr)] gap-1 text-[10px] leading-4"
                >
                  <span className="font-mono text-white/30">
                    {new Date(entry.updatedAt).toLocaleTimeString()}
                  </span>
                  <span className="truncate text-cyan-300/70">
                    {entry.stage ?? entry.phase}
                  </span>
                  <span className="truncate text-white/50">
                    {entry.message}
                  </span>
                </p>
              ))
            ) : (
              <p className="text-[10px] text-white/30">Waiting for updates.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StageDot({
  label,
  state,
}: {
  label: string;
  state: "done" | "current" | "waiting" | "failed";
}) {
  const tone =
    state === "done"
      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
      : state === "current"
        ? "border-cyan-500/50 bg-cyan-500/15 text-cyan-300"
        : state === "failed"
          ? "border-rose-500/50 bg-rose-500/15 text-rose-300"
          : "border-white/[0.08] bg-white/[0.02] text-white/30";
  return (
    <div
      className={cn(
        "flex h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-md border",
        tone,
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          state === "done"
            ? "bg-emerald-400"
            : state === "current"
              ? "bg-cyan-400 animate-pulse"
              : state === "failed"
                ? "bg-rose-400"
                : "bg-white/20",
        )}
      />
      <span className="max-w-full truncate text-[10px] font-medium">
        {label}
      </span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-white/[0.05] bg-white/[0.025] px-2 py-1">
      <div className="text-[10px] text-white/30">{label}</div>
      <div className="truncate font-mono text-[11px] text-white/70">
        {value}
      </div>
    </div>
  );
}

function stageFromPhase(phase: MLTrainingUpdate["phase"]): string {
  if (phase === "started") return "loading";
  if (phase === "loading") return "loading";
  if (phase === "validating") return "gate";
  if (phase === "exporting") return "export";
  if (phase === "completed") return "complete";
  if (phase === "failed") return "failed";
  if (phase === "rejected") return "rejected";
  return "cpcv";
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
