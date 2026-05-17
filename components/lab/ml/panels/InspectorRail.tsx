"use client";

/**
 * InspectorRail — Dense 4-column grid: training set, feature contract, inference, failures.
 */

import { cn } from "@/lib/utils";
import { AlertTriangle, CircleGauge, Database, SlidersHorizontal } from "lucide-react";
import type { PipelineData } from "../types";

type Tone = "good" | "warn" | "bad" | "info" | "neutral";
const TX: Record<Tone, string> = {
  good: "text-emerald-400", warn: "text-amber-400", bad: "text-rose-400",
  info: "text-cyan-400", neutral: "text-white/50",
};

export function InspectorRail({ data }: { data: PipelineData }) {
  const s = data.featureContract.semanticChecks;
  const ok = data.featureContract.allVersionsMatch && data.featureContract.allLengthsMatch && data.featureContract.allSemanticChecksPass;

  return (
    <div className="grid gap-1.5 md:grid-cols-2 xl:grid-cols-4">
      <Card title="Training set" icon={Database}>
        <KV label="Clean" value={data.dataCollection.qualifiedForTraining.toLocaleString()} tone="good" />
        <KV label="Raw labeled" value={(s.cleanLabeledExamples ?? 0).toLocaleString()} />
        <KV label="Stale EV" value={(s.badLabeledNonPositiveEv ?? 0).toLocaleString()} tone={(s.badLabeledNonPositiveEv ?? 0) > 0 ? "warn" : "good"} />
        <KV label="Bad tier" value={s.badLabeledCompetitionTier.toLocaleString()} tone={s.badLabeledCompetitionTier > 0 ? "bad" : "good"} />
      </Card>

      <Card title="Feature contract" icon={SlidersHorizontal}>
        <KV label="Version" value={`v${data.featureContract.currentVersion}`} tone={data.featureContract.allVersionsMatch ? "good" : "bad"} />
        <KV label="Count" value={data.featureContract.currentFeatureCount.toLocaleString()} tone={data.featureContract.allLengthsMatch ? "good" : "bad"} />
        <KV label="Hash" value={data.featureContract.currentNamesHash} />
        <KV label="Status" value={ok ? "ok" : "review"} tone={ok ? "good" : "warn"} />
      </Card>

      <Card title="Inference" icon={CircleGauge}>
        <KV label="Loaded" value={data.inference.modelLoaded ? `v${data.inference.modelVersion}` : "no"} tone={data.inference.modelLoaded ? "good" : "neutral"} />
        <KV label="Latency" value={`${data.inference.avgInferenceMs.toFixed(1)}ms`} />
        <KV label="Mode" value={data.deploymentGate.permissionLevel.replaceAll("_", " ")} />
        <KV label="Gate" value={data.deploymentGate.canGate ? "yes" : "no"} tone={data.deploymentGate.canGate ? "good" : "neutral"} />
      </Card>

      <Card title="Failures" icon={AlertTriangle}>
        {data.rejectedModels.length > 0 ? (
          <div className="space-y-1">
            {data.rejectedModels.slice(0, 3).map((m) => (
              <div key={`${m.version}-${m.createdAt ?? ""}`} className="rounded border border-white/[0.04] bg-white/[0.02] px-1.5 py-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="font-mono text-white/60">v{m.version}</span>
                  <span className="text-white/25">{m.status}</span>
                </div>
                <p className="text-[9px] text-white/30 truncate mt-0.5">{m.reasons[0] ?? "—"}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-white/25">None.</p>
        )}
      </Card>
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 backdrop-blur-sm">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="size-3 text-cyan-400" />
        <span className="text-[10px] font-semibold text-white/70">{title}</span>
      </div>
      <div className="space-y-0.5 text-[10px]">{children}</div>
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-white/35 truncate">{label}</span>
      <span className={cn("truncate text-right font-medium tabular-nums", tone ? TX[tone] : "text-white/55")}>{value}</span>
    </div>
  );
}
