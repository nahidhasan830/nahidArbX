"use client";

/**
 * LiveTrainingPanel — Progress bar + log for an in-flight training run.
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { MLTrainingUpdate } from "@/lib/events/event-bus";

type Tone = "good" | "warn" | "bad" | "info";

const TONE_STYLES = {
  good: { border: "border-emerald-500/30", bg: "bg-emerald-500/10", dot: "bg-emerald-400", text: "text-emerald-400" },
  warn: { border: "border-amber-500/30", bg: "bg-amber-500/10", dot: "bg-amber-400", text: "text-amber-400" },
  bad: { border: "border-rose-500/30", bg: "bg-rose-500/10", dot: "bg-rose-400", text: "text-rose-400" },
  info: { border: "border-cyan-500/30", bg: "bg-cyan-500/10", dot: "bg-cyan-400", text: "text-cyan-400" },
} satisfies Record<Tone, Record<string, string>>;

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
  const isTerminal = ["completed", "failed", "rejected"].includes(training.phase);
  const [tick, setTick] = useState(0);
  const baseElapsed = training.elapsedMs ?? 0;

  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setTick((v) => v + 1000), 1000);
    return () => clearInterval(id);
  }, [isTerminal]);

  const elapsed = baseElapsed + tick;
  const progress = isTerminal ? 100 : Math.min(99, Math.round(elapsed / 9000));
  const tone: Tone =
    training.phase === "failed"
      ? "bad"
      : training.phase === "rejected"
        ? "warn"
        : training.phase === "completed"
          ? "good"
          : "info";

  const t = TONE_STYLES[tone];

  return (
    <div
      className={cn(
        "rounded-xl border p-3 shadow-lg backdrop-blur-md transition-all",
        t.border,
        t.bg,
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", t.text)}>
              <span className={cn("size-1.5 rounded-full", t.dot, !isTerminal && "animate-pulse")} />
              Training v{training.version}
            </span>
            {isConnected && (
              <span className="text-xs text-white/40">live stream</span>
            )}
          </div>
          <p className="mt-1 text-sm text-white/80">{training.message}</p>
        </div>
        <div className="grid grid-cols-3 gap-4 text-right text-xs">
          <KV label="Examples" value={dataCount.toLocaleString()} />
          <KV label="Elapsed" value={formatElapsed(elapsed)} />
          <KV label="Phase" value={training.phase} tone={t.text} />
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/30">
        <div
          className={cn("h-full rounded-full transition-all duration-700", t.dot)}
          style={{ width: `${progress}%` }}
        />
      </div>
      {log.length > 1 && (
        <div className="mt-3 grid gap-1 text-xs text-white/40 md:grid-cols-3">
          {log.slice(0, 3).map((entry, index) => (
            <p key={`${entry.modelId}-${entry.phase}-${index}`} className="truncate">
              {new Date(entry.updatedAt).toLocaleTimeString()} · {entry.phase}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-white/40">{label}</dt>
      <dd className={cn("font-medium tabular-nums", tone ?? "text-white/80")}>{value}</dd>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
