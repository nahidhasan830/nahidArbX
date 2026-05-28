"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  FileText,
  Gauge,
  History,
  Loader2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Target,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type {
  NameType,
  ValueType,
} from "recharts/types/component/DefaultTooltipContent";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  LearningCalibrationBucket,
  LearningExplanationResponse,
  LearningFeatureImportance,
  LearningModelHistoryRow,
  LearningScoreBucket,
  LearningSnapshotMetrics,
  LearningSnapshotResponse,
  LearningVerdict,
} from "@/lib/ml/learning/types";

type LearningResponse = {
  snapshot: LearningSnapshotResponse | null;
  explanation: LearningExplanationResponse | null;
};

type ValueTone = "neutral" | "good" | "bad" | "warn";

const PROOF_STEPS = [
  {
    key: "sample",
    label: "Enough settled rows",
    description: "The verdict should be based on resolved predictions.",
  },
  {
    key: "lift",
    label: "Beats simple EV",
    description: "ML-gated rows should outperform the fixed rule.",
  },
  {
    key: "ranking",
    label: "Score ranks outcomes",
    description: "Higher buckets should settle better than lower buckets.",
  },
  {
    key: "trust",
    label: "Calibration is sane",
    description: "Predicted probabilities should match observed results.",
  },
] as const;

const SCORE_LADDER_SKELETON_BARS = [
  "h-[34%]",
  "h-[48%]",
  "h-[42%]",
  "h-[64%]",
  "h-[58%]",
  "h-[76%]",
  "h-[68%]",
  "h-[86%]",
] as const;

const LEARNING_CHART_SKELETON_BARS = [
  "h-[45%]",
  "h-[62%]",
  "h-[54%]",
  "h-[72%]",
  "h-[66%]",
  "h-[82%]",
] as const;

export function MLLearningPanel() {
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [explaining, setExplaining] = useState<"flash" | "pro" | null>(null);

  const { data, isLoading, isFetching } = useQuery<LearningResponse>({
    queryKey: ["ml", "learning"],
    queryFn: async () => {
      const res = await fetch("/api/ml/learning", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: 30000,
    retry: 1,
  });

  const snapshot = data?.snapshot ?? null;
  const explanation = data?.explanation ?? null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/ml/learning/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ explain: true, modelTier: "flash" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success("Learning snapshot refreshed");
      void qc.invalidateQueries({ queryKey: ["ml", "learning"] });
      void qc.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) {
      toast.error("Learning refresh failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefreshing(false);
    }
  };

  const explain = async (modelTier: "flash" | "pro", force = false) => {
    setExplaining(modelTier);
    try {
      const res = await fetch("/api/ml/learning/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelTier, force }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toast.success(
        modelTier === "pro"
          ? "Deep review stored"
          : "Learning read stored",
      );
      void qc.invalidateQueries({ queryKey: ["ml", "learning"] });
    } catch (err) {
      toast.error("DeepSeek analysis failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setExplaining(null);
    }
  };

  if (isLoading) return <LearningLoadingState />;

  if (!snapshot) {
    return (
      <section className="rounded-md border border-border bg-card p-4 shadow-sm">
        <PanelHeader
          icon={BrainCircuit}
          title="Learning evidence"
          description="No scored prediction evidence is available yet."
        />
        <div className="mt-4">
          <EmptyBlock text="Once ML scores bets and those rows settle, this view will show whether the model is learning." />
        </div>
      </section>
    );
  }

  const metrics = snapshot.metrics;
  const tone = learningVerdictTone(snapshot.verdict);
  const proof = buildProofState(metrics);

  return (
    <div className="grid gap-3">
      <section
        className={cn(
          "overflow-hidden rounded-md border bg-card shadow-sm",
          tone.border,
        )}
      >
        <div className="grid xl:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.35fr)]">
          <div className={cn("border-b p-4 xl:border-b-0 xl:border-r", tone.wash)}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badge
                variant="outline"
                className={cn("h-6 rounded-md px-2 text-xs", tone.badge)}
              >
                {cleanText(metrics.verdict.label)}
              </Badge>
              <span className="font-mono text-[11px] uppercase text-muted-foreground">
                {metrics.verdict.confidence} confidence
              </span>
            </div>
            <h2 className="mt-4 text-2xl font-semibold leading-tight text-balance">
              {cleanText(metrics.verdict.reason)}
            </h2>
            <p className="mt-3 max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
              Snapshot {snapshot.snapshotHash.slice(0, 10)} saved{" "}
              {formatWhen(snapshot.createdAt)}. The data cutoff is{" "}
              {formatDate(snapshot.dataAsOf)}.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <ActionButton
                icon={refreshing ? Loader2 : RefreshCw}
                label="Refresh evidence"
                loading={refreshing}
                variant="outline"
                hint="Recompute metrics from latest settlements and cache the snapshot."
                onClick={() => void refresh()}
              />
              {isFetching ? (
                <span className="font-mono text-[11px] uppercase text-muted-foreground">
                  Refreshing
                </span>
              ) : null}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 xl:grid-cols-4">
            <EvidenceMetric
              label="Settled predictions"
              value={formatInt(metrics.counts.settledPredictions)}
              detail={`${formatInt(metrics.counts.pendingPredictions)} pending`}
              tone={metrics.counts.settledPredictions >= 100 ? "good" : "warn"}
            />
            <EvidenceMetric
              label="ML gate ROI"
              value={formatPct(metrics.cohorts.mlGate.roiPct)}
              detail={`n=${formatInt(metrics.cohorts.mlGate.sampleSize)}`}
              tone={signedTone(metrics.cohorts.mlGate.roiPct)}
            />
            <EvidenceMetric
              label="Lift vs simple"
              value={formatPct(metrics.quality.roiLiftPct)}
              detail={`simple ${formatPct(metrics.cohorts.simpleEvCore.roiPct)}`}
              tone={signedTone(metrics.quality.roiLiftPct)}
            />
            <EvidenceMetric
              label="Calibration error"
              value={formatDecimal(metrics.quality.calibrationError, 4)}
              detail={`Brier ${formatDecimal(metrics.quality.brierScore, 4)}`}
              tone={calibrationTone(metrics.quality.calibrationError)}
            />
          </div>
        </div>
      </section>

      <Tabs defaultValue="evidence" className="gap-3">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 shadow-sm md:flex-row md:items-center md:justify-between">
          <TabsList variant="line" className="h-9 w-full justify-start md:w-fit">
            <TabsTrigger value="evidence" className="flex-1 text-xs md:flex-none">
              <ShieldCheck className="size-3.5" />
              Evidence
            </TabsTrigger>
            <TabsTrigger value="deepseek" className="flex-1 text-xs md:flex-none">
              <BrainCircuit className="size-3.5" />
              DeepSeek read
            </TabsTrigger>
            <TabsTrigger value="features" className="flex-1 text-xs md:flex-none">
              <BarChart3 className="size-3.5" />
              Features
            </TabsTrigger>
          </TabsList>
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            Deterministic metrics first. Open AI interpretation only when you
            need the prose readout.
          </p>
        </div>

        <TabsContent value="evidence" className="m-0 grid gap-3">
          <section className="rounded-md border border-border bg-card p-3 shadow-sm">
            <PanelHeader
              icon={ShieldCheck}
              title="Proof chain"
              description="The learning verdict is only useful when each evidence link holds."
            />
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {PROOF_STEPS.map((step) => (
                <ProofStep
                  key={step.key}
                  label={step.label}
                  description={step.description}
                  state={proof[step.key]}
                />
              ))}
            </div>
          </section>

          <section className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="rounded-md border border-border bg-card p-3 shadow-sm">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <PanelHeader
                  icon={SlidersHorizontal}
                  title="Score ladder"
                  description="Higher score buckets should produce stronger settlement results."
                />
                <div className="grid grid-cols-3 gap-2 lg:w-[360px]">
                  <MiniStat
                    label="Monotonicity"
                    value={formatPct(
                      metrics.quality.scoreMonotonicity == null
                        ? null
                        : metrics.quality.scoreMonotonicity * 100,
                    )}
                    tone={
                      (metrics.quality.scoreMonotonicity ?? 0) >= 0.6
                        ? "good"
                        : "warn"
                    }
                  />
                  <MiniStat
                    label="Model AUC"
                    value={formatDecimal(metrics.quality.aucRoc, 3)}
                  />
                  <MiniStat
                    label="Log loss"
                    value={formatDecimal(metrics.quality.logLoss, 4)}
                  />
                </div>
              </div>
              <div className="mt-3 h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={metrics.scoreBuckets}
                    margin={{ left: -4, right: 12, top: 10, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke="currentColor"
                      strokeDasharray="3 3"
                      opacity={0.08}
                      vertical={false}
                    />
                    <XAxis
                      dataKey="bucket"
                      tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
                      tickLine={false}
                      axisLine={{ stroke: "currentColor", opacity: 0.16 }}
                    />
                    <YAxis
                      tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: number) => `${value}%`}
                      width={42}
                    />
                    <RechartsTooltip
                      cursor={{ fill: "hsl(var(--muted))", opacity: 0.45 }}
                      content={(props) => <LearningBucketTooltip {...props} />}
                    />
                    <ReferenceLine
                      y={0}
                      stroke="currentColor"
                      strokeDasharray="2 4"
                      opacity={0.42}
                    />
                    <Bar
                      dataKey="roiPct"
                      fill="rgb(34 197 94)"
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <LearningHealthCard snapshot={snapshot} />
          </section>

          <section className="grid items-start gap-3 xl:grid-cols-2">
            <LearningChartCard
              icon={Target}
              title="Calibration map"
              description="Predicted probability should track observed settlement rate."
            >
              <CalibrationChart rows={metrics.calibrationBuckets} />
            </LearningChartCard>

            <LearningChartCard
              icon={History}
              title="Model versions"
              description="Retrains should improve out-of-sample quality without hidden overfit."
            >
              <ModelHistoryChart rows={metrics.modelHistory} />
            </LearningChartCard>
          </section>
        </TabsContent>

        <TabsContent value="deepseek" className="m-0">
          <LearningExplanationCard
            explanation={explanation}
            snapshot={snapshot}
            standardLoading={explaining === "flash"}
            deepLoading={explaining === "pro"}
            onStandardRead={() => void explain("flash", false)}
            onDeepAudit={() => void explain("pro", true)}
          />
        </TabsContent>

        <TabsContent value="features" className="m-0 grid gap-3">
          <FeatureImportanceCard features={metrics.featureImportance} />
          <section className="grid items-start gap-3 xl:grid-cols-2">
            <LearningChartCard
              icon={Target}
              title="Calibration map"
              description="Probability quality by score range."
            >
              <CalibrationChart rows={metrics.calibrationBuckets} />
            </LearningChartCard>
            <LearningChartCard
              icon={History}
              title="Model versions"
              description="Version-level lift and AUC history."
            >
              <ModelHistoryChart rows={metrics.modelHistory} />
            </LearningChartCard>
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LearningLoadingState() {
  return (
    <div className="grid gap-3">
      <section className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="grid xl:grid-cols-[minmax(360px,0.95fr)_minmax(0,1.35fr)]">
          <div className="border-b border-border bg-muted/20 p-4 xl:border-b-0 xl:border-r">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-6 w-32 rounded-md" />
              <Skeleton className="h-3 w-24 rounded-sm" />
            </div>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-7 w-full max-w-[520px] rounded-md" />
              <Skeleton className="h-7 w-4/5 max-w-[440px] rounded-md" />
            </div>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-full max-w-[640px] rounded-sm" />
              <Skeleton className="h-4 w-2/3 max-w-[420px] rounded-sm" />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Skeleton className="h-8 w-32 rounded-md" />
              <Skeleton className="h-3 w-20 rounded-sm" />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="min-w-0 border-b border-border p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0"
              >
                <Skeleton className="h-3 w-28 rounded-sm" />
                <Skeleton className="mt-3 h-8 w-20 rounded-md" />
                <Skeleton className="mt-2 h-3 w-24 rounded-sm" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="grid h-9 w-full grid-cols-3 gap-1 md:w-[360px]">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-9 rounded-md" />
          ))}
        </div>
        <Skeleton className="h-3 w-full max-w-[420px] rounded-sm" />
      </div>

      <section className="rounded-md border border-border bg-card p-3 shadow-sm">
        <div className="flex items-start gap-2.5">
          <Skeleton className="size-8 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-28 rounded-sm" />
            <Skeleton className="h-4 w-full max-w-[520px] rounded-sm" />
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={index}
              className="rounded-md border border-border bg-background p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-32 rounded-sm" />
                  <Skeleton className="h-3 w-full rounded-sm" />
                  <Skeleton className="h-3 w-4/5 rounded-sm" />
                </div>
                <Skeleton className="size-7 shrink-0 rounded-md" />
              </div>
              <Skeleton className="mt-3 h-3 w-20 rounded-sm" />
            </div>
          ))}
        </div>
      </section>

      <section className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-md border border-border bg-card p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-4 w-28 rounded-sm" />
                <Skeleton className="h-4 w-72 max-w-full rounded-sm" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 lg:w-[360px]">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-14 rounded-md" />
              ))}
            </div>
          </div>
          <div className="mt-3 flex h-[300px] items-end gap-2 rounded-md border border-border/70 bg-background/60 p-3">
            {SCORE_LADDER_SKELETON_BARS.map((heightClass, index) => (
              <Skeleton
                key={index}
                className={cn("flex-1 rounded-t-sm", heightClass)}
              />
            ))}
          </div>
        </div>

        <div className="rounded-md border border-border bg-card p-3 shadow-sm">
          <div className="flex items-start gap-2.5">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-36 rounded-sm" />
              <Skeleton className="h-4 w-full rounded-sm" />
            </div>
          </div>
          <div className="mt-3 grid gap-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="rounded-md border border-border bg-background p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <Skeleton className="h-3 w-28 rounded-sm" />
                  <Skeleton className="h-5 w-16 rounded-md" />
                </div>
                <Skeleton className="mt-3 h-2 w-full rounded-sm" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid items-start gap-3 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, section) => (
          <div
            key={section}
            className="rounded-md border border-border bg-card p-3 shadow-sm"
          >
            <div className="flex items-start gap-2.5">
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-4 w-36 rounded-sm" />
                <Skeleton className="h-4 w-full max-w-[420px] rounded-sm" />
              </div>
            </div>
            <div className="mt-3 h-[250px] rounded-md border border-border/70 bg-background/60 p-3">
              <div className="grid h-full grid-cols-6 items-end gap-2">
                {LEARNING_CHART_SKELETON_BARS.map((heightClass, index) => (
                  <Skeleton
                    key={index}
                    className={cn("rounded-t-sm", heightClass)}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  hint,
  loading,
  variant = "default",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  loading: boolean;
  variant?: "default" | "outline";
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={variant}
          disabled={loading}
          onClick={onClick}
          className="h-8 text-xs"
        >
          <Icon className={cn("size-3.5", loading && "animate-spin")} />
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[260px] text-sm">{hint}</TooltipContent>
    </Tooltip>
  );
}

function PanelHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

function EvidenceMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: ValueTone;
}) {
  return (
    <div className="min-w-0 border-b border-border p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-2 truncate font-mono text-2xl font-semibold tabular-nums",
          valueToneClass(tone),
        )}
      >
        {cleanText(value)}
      </p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {cleanText(detail)}
      </p>
    </div>
  );
}

function ProofStep({
  label,
  description,
  state,
}: {
  label: string;
  description: string;
  state: { status: "pass" | "warn" | "fail"; value: string };
}) {
  const Icon =
    state.status === "pass"
      ? CheckCircle2
      : state.status === "fail"
        ? AlertTriangle
        : Gauge;
  const tone =
    state.status === "pass"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : state.status === "fail"
        ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
        : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md border",
            tone,
          )}
        >
          <Icon className="size-3.5" />
        </span>
      </div>
      <p className="mt-3 font-mono text-xs font-semibold tabular-nums">
        {cleanText(state.value)}
      </p>
    </div>
  );
}

function LearningChartCard({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3 shadow-sm">
      <PanelHeader icon={icon} title={title} description={description} />
      <div className="mt-3 h-[250px]">{children}</div>
    </div>
  );
}

function CalibrationChart({ rows }: { rows: LearningCalibrationBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ left: -4, right: 12, top: 10, bottom: 0 }}>
        <CartesianGrid
          stroke="currentColor"
          strokeDasharray="3 3"
          opacity={0.08}
          vertical={false}
        />
        <XAxis
          dataKey="bucket"
          tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
          tickLine={false}
          axisLine={{ stroke: "currentColor", opacity: 0.16 }}
        />
        <YAxis
          tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
          tickLine={false}
          axisLine={false}
          domain={[0, 100]}
          tickFormatter={(value: number) => `${value}%`}
          width={42}
        />
        <RechartsTooltip content={(props) => <CalibrationTooltip {...props} />} />
        <Line
          type="monotone"
          dataKey="predictedPct"
          stroke="rgb(148 163 184)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="actualPct"
          stroke="rgb(34 197 94)"
          strokeWidth={2}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ModelHistoryChart({ rows }: { rows: LearningModelHistoryRow[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={rows} margin={{ left: -4, right: 12, top: 10, bottom: 0 }}>
        <CartesianGrid
          stroke="currentColor"
          strokeDasharray="3 3"
          opacity={0.08}
          vertical={false}
        />
        <XAxis
          dataKey="version"
          tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
          tickLine={false}
          axisLine={{ stroke: "currentColor", opacity: 0.16 }}
        />
        <YAxis
          tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
          tickLine={false}
          axisLine={false}
          width={42}
        />
        <RechartsTooltip content={(props) => <ModelHistoryTooltip {...props} />} />
        <ReferenceLine
          y={0}
          stroke="currentColor"
          strokeDasharray="2 4"
          opacity={0.42}
        />
        <Line
          type="monotone"
          dataKey="modelVsSimpleRoiDelta"
          stroke="rgb(34 197 94)"
          strokeWidth={2}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="oosAucRoc"
          stroke="rgb(148 163 184)"
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function LearningExplanationCard({
  explanation,
  snapshot,
  standardLoading,
  deepLoading,
  onStandardRead,
  onDeepAudit,
}: {
  explanation: LearningExplanationResponse | null;
  snapshot: LearningSnapshotResponse;
  standardLoading: boolean;
  deepLoading: boolean;
  onStandardRead: () => void;
  onDeepAudit: () => void;
}) {
  const content = explanation?.content;
  const leadItems = useMemo(() => {
    if (!content) return [];
    return [
      { title: "Improved", items: content.whatImproved, tone: "good" },
      { title: "Regressed", items: content.whatRegressed, tone: "bad" },
      { title: "Risks", items: content.risks, tone: "warn" },
      { title: "Next actions", items: content.nextActions, tone: "neutral" },
    ] as const;
  }, [content]);

  return (
    <section className="rounded-md border border-border bg-card p-3 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <PanelHeader
          icon={BrainCircuit}
          title="DeepSeek read"
          description="Optional interpretation of the metric verdict. Evidence remains the source of truth."
        />
        <span className="font-mono text-[11px] uppercase text-muted-foreground">
          Snapshot {snapshot.snapshotHash.slice(0, 10)}
        </span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <AiReviewAction
          icon={BrainCircuit}
          title="Standard readout"
          description={
            content
              ? "Use the cached interpretation unless this snapshot changes."
              : "Generate a concise interpretation for this snapshot."
          }
          buttonLabel={content ? "Refresh readout" : "Generate readout"}
          loading={standardLoading}
          onClick={onStandardRead}
        />
        <AiReviewAction
          icon={FileText}
          title="Deep audit"
          description="Force a fresh, slower review when the evidence is ambiguous."
          buttonLabel="Run deep audit"
          loading={deepLoading}
          variant="outline"
          onClick={onDeepAudit}
        />
      </div>

      {content ? (
        <div className="mt-3 grid gap-3">
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-sm font-semibold">{cleanText(content.verdict)}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {cleanText(content.summary)}
            </p>
          </div>
          <div className="grid gap-2">
            {leadItems.map((group) => (
              <LearningList
                key={group.title}
                title={group.title}
                items={group.items}
                tone={group.tone}
              />
            ))}
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <p className="text-xs font-semibold text-muted-foreground">
              Mental model
            </p>
            <p className="mt-1 text-sm leading-relaxed">
              {cleanText(content.mentalModel)}
            </p>
          </div>
          <p className="font-mono text-[11px] text-muted-foreground">
            {cleanText(explanation.model)} - {formatWhen(explanation.generatedAt)}
          </p>
        </div>
      ) : (
        <div className="mt-3">
          <EmptyBlock
            text={`Snapshot ${snapshot.snapshotHash.slice(0, 10)} has no cached explanation yet.`}
          />
        </div>
      )}
    </section>
  );
}

function AiReviewAction({
  icon: Icon,
  title,
  description,
  buttonLabel,
  loading,
  variant = "default",
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  buttonLabel: string;
  loading: boolean;
  variant?: "default" | "outline";
  onClick: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant={variant}
            disabled={loading}
            onClick={onClick}
            className="mt-3 h-8 w-full text-xs"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Icon className="size-3.5" />
            )}
            {buttonLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px] text-sm">
          {description}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function LearningList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: ValueTone;
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className={cn("text-xs font-semibold", valueToneClass(tone))}>
        {title}
      </p>
      <div className="mt-2 grid gap-1.5">
        {items.slice(0, 5).map((item, index) => (
          <p key={`${title}-${index}`} className="text-sm leading-relaxed">
            {cleanText(item)}
          </p>
        ))}
      </div>
    </div>
  );
}

function LearningHealthCard({
  snapshot,
}: {
  snapshot: LearningSnapshotResponse;
}) {
  const metrics = snapshot.metrics;
  return (
    <section className="rounded-md border border-border bg-card p-3 shadow-sm">
      <PanelHeader
        icon={ShieldCheck}
        title="Evidence health"
        description="Checks that decide whether the learning verdict is trustworthy."
      />
      <div className="mt-3 grid gap-2">
        <KeyValue
          label="Settlement lag"
          value={formatPct(metrics.quality.settlementLagPct)}
          tone={metrics.quality.settlementLagPct < 60 ? "good" : "warn"}
        />
        <KeyValue
          label="Overfit risk"
          value={metrics.quality.overfitRisk}
          tone={
            metrics.quality.overfitRisk === "low"
              ? "good"
              : metrics.quality.overfitRisk === "high"
                ? "bad"
                : "warn"
          }
        />
        <KeyValue
          label="Training examples"
          value={formatInt(metrics.counts.currentContractExamples)}
        />
        <KeyValue
          label="Excluded old contract"
          value={formatInt(metrics.counts.excludedContractPredictions)}
          tone={
            metrics.counts.excludedContractPredictions > 0 ? "warn" : "good"
          }
        />
        <KeyValue
          label="Real placed settled"
          value={formatInt(metrics.counts.placedSettled)}
          tone={metrics.counts.placedSettled > 0 ? "good" : "warn"}
        />
      </div>
      {metrics.verdict.blockers.length > 0 ? (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            Blockers
          </p>
          <div className="mt-2 grid gap-1.5">
            {metrics.verdict.blockers.map((blocker) => (
              <p
                key={blocker}
                className="text-sm leading-relaxed text-amber-800 dark:text-amber-200"
              >
                {cleanText(blocker)}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function FeatureImportanceCard({
  features,
}: {
  features: LearningFeatureImportance[];
}) {
  const maxImportance = Math.max(...features.map((feature) => feature.importance), 0);

  return (
    <section className="rounded-md border border-border bg-card p-3 shadow-sm">
      <PanelHeader
        icon={BarChart3}
        title="Feature drivers"
        description="Top learned signals from the deployed or latest model report."
      />
      <div className="mt-3 grid gap-2">
        {features.length > 0 ? (
          features.slice(0, 8).map((feature) => (
            <div
              key={feature.feature}
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="grid grid-cols-[32px_minmax(0,1fr)_80px] items-center gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">
                  #{feature.rank}
                </span>
                <span className="truncate text-sm font-medium">
                  {cleanText(feature.feature)}
                </span>
                <span className="text-right font-mono text-[11px] tabular-nums">
                  {formatDecimal(feature.importance, 4)}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-muted">
                <div
                  className="h-full rounded-sm bg-emerald-500"
                  style={{
                    width:
                      maxImportance > 0
                        ? `${Math.max(4, (feature.importance / maxImportance) * 100)}%`
                        : "4%",
                  }}
                />
              </div>
            </div>
          ))
        ) : (
          <EmptyBlock text="No feature importance report is stored yet." />
        )}
      </div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: ValueTone;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5">
      <p className="truncate text-[11px] font-semibold text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "truncate font-mono text-xs font-semibold tabular-nums",
          valueToneClass(tone),
        )}
      >
        {cleanText(value)}
      </p>
    </div>
  );
}

function KeyValue({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: ValueTone;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2">
      <span className="text-sm text-muted-foreground">{cleanText(label)}</span>
      <span
        className={cn(
          "text-right font-mono text-xs font-semibold tabular-nums",
          valueToneClass(tone),
        )}
      >
        {cleanText(value)}
      </span>
    </div>
  );
}

function EmptyBlock({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-background p-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function LearningBucketTooltip({
  active,
  payload,
}: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as LearningScoreBucket;
  return (
    <div className="rounded-md border border-border bg-popover p-2 text-xs shadow-md">
      <p className="font-semibold">{cleanText(row.bucket)}</p>
      <p className="mt-1 text-muted-foreground">n={formatInt(row.count)}</p>
      <p>ROI {formatPct(row.roiPct)}</p>
      <p>Win {formatPct(row.winRatePct)}</p>
      <p>Avg score {formatDecimal(row.avgScore, 3)}</p>
    </div>
  );
}

function CalibrationTooltip({
  active,
  payload,
}: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as LearningCalibrationBucket;
  return (
    <div className="rounded-md border border-border bg-popover p-2 text-xs shadow-md">
      <p className="font-semibold">{cleanText(row.bucket)}</p>
      <p className="mt-1 text-muted-foreground">n={formatInt(row.count)}</p>
      <p>Predicted {formatPct(row.predictedPct)}</p>
      <p>Actual {formatPct(row.actualPct)}</p>
      <p>Gap {formatPct(row.gapPct)}</p>
    </div>
  );
}

function ModelHistoryTooltip({
  active,
  payload,
}: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as LearningModelHistoryRow;
  return (
    <div className="rounded-md border border-border bg-popover p-2 text-xs shadow-md">
      <p className="font-semibold">v{row.version}</p>
      <p className="mt-1 text-muted-foreground">{cleanText(row.status)}</p>
      <p>AUC {formatDecimal(row.oosAucRoc, 3)}</p>
      <p>ROI delta {formatPct(row.modelVsSimpleRoiDelta)}</p>
      <p>Samples {formatInt(row.trainingSamples)}</p>
    </div>
  );
}

function buildProofState(metrics: LearningSnapshotMetrics) {
  const settled = metrics.counts.settledPredictions;
  const lift = metrics.quality.roiLiftPct;
  const monotonicity = metrics.quality.scoreMonotonicity;
  const calibration = metrics.quality.calibrationError;

  return {
    sample: {
      status:
        settled >= 100 ? "pass" : settled >= 30 ? "warn" : "fail",
      value: `${formatInt(settled)} settled`,
    },
    lift: {
      status:
        lift == null ? "warn" : lift > 0 ? "pass" : "fail",
      value: formatPct(lift),
    },
    ranking: {
      status:
        monotonicity == null
          ? "warn"
          : monotonicity >= 0.6
            ? "pass"
            : "warn",
      value: formatPct(monotonicity == null ? null : monotonicity * 100),
    },
    trust: {
      status:
        calibration == null
          ? "warn"
          : calibration <= 0.08
            ? "pass"
            : calibration <= 0.14
              ? "warn"
              : "fail",
      value: formatDecimal(calibration, 4),
    },
  } satisfies Record<
    (typeof PROOF_STEPS)[number]["key"],
    { status: "pass" | "warn" | "fail"; value: string }
  >;
}

function learningVerdictTone(verdict: LearningVerdict) {
  if (verdict === "learning") {
    return {
      badge:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      border: "border-emerald-500/30",
      wash: "border-border bg-emerald-500/5",
    };
  }
  if (
    verdict === "not_enough_settled_evidence" ||
    verdict === "settlement_lag"
  ) {
    return {
      badge:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      border: "border-amber-500/30",
      wash: "border-border bg-amber-500/5",
    };
  }
  return {
    badge: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    border: "border-rose-500/30",
    wash: "border-border bg-rose-500/5",
  };
}

function calibrationTone(value: number | null | undefined): ValueTone {
  if (value == null || !Number.isFinite(value)) return "neutral";
  if (value <= 0.08) return "good";
  if (value <= 0.14) return "warn";
  return "bad";
}

function valueToneClass(tone: ValueTone) {
  if (tone === "good") return "text-emerald-700 dark:text-emerald-300";
  if (tone === "bad") return "text-rose-700 dark:text-rose-300";
  if (tone === "warn") return "text-amber-700 dark:text-amber-300";
  return "text-foreground";
}

function signedTone(value: number | null | undefined): ValueTone {
  if (value == null || !Number.isFinite(value) || value === 0) {
    return "neutral";
  }
  return value > 0 ? "good" : "bad";
}

function formatInt(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return Math.round(value).toLocaleString();
}

function formatPct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatDecimal(value: number | null | undefined, digits = 3) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return format(date, "MMM d HH:mm");
}

function formatWhen(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

function cleanText(value: unknown) {
  return String(value ?? "-").replace(/[\u2014\u2013]/g, "-");
}
