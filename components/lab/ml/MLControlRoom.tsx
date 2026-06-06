"use client";

import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import {
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
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Database,
  Gauge,
  GitBranch,
  History,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { MarketDisplay } from "@/components/ui/market-display";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { buildDecisionReason } from "@/lib/ml/decision-reason";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatAtomLabel } from "@/lib/formatting/labels";
import { fmtDateTime, fmtSeen } from "@/lib/formatting/helpers";
import {
  formatPermissionLevel,
  formatRungInputLabel,
  formatRungInputValue,
} from "@/lib/lab/ml/display";
import {
  getProviderShortName,
  getProviderTextInline,
} from "@/lib/providers/registry";
import type {
  EvaluatedRung,
  RungAction,
  RungCategory,
  RungStatus,
} from "@/lib/lab/ml/rungs";
import type { PipelineData } from "./types";
import { MLLearningPanel } from "./MLLearningPanel";

interface Props {
  data: PipelineData;
  rungs: EvaluatedRung[];
}

type ModelRow = PipelineData["modelHistory"][number];
type PaperMetric =
  PipelineData["paperEvaluation"]["metrics"][keyof PipelineData["paperEvaluation"]["metrics"]];
type RoiTrendRow = PipelineData["paperEvaluation"]["trend"][number];
type RoiTrendStrategy = "baseline" | "simple" | "mlGate";
type RoiTrendPoint = RoiTrendRow & {
  label: string;
};
type ValueTone = "neutral" | "good" | "bad" | "warn";

type PredictionAuditRow = {
  id: number;
  betId: string;
  scoredAt: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  eventStartTime: string;
  marketType: string;
  timeScope: string;
  familyLine: number | null;
  atomLabel: string;
  softProvider: string;
  softOdds: number;
  softCommissionPct: number;
  sharpProvider: string;
  sharpOdds: number;
  baselineEvPct: number | null;
  baselineKellyFraction: number | null;
  modelVersion: number | null;
  mlScore: number;
  modelEdgePct: number | null;
  kellyMultiplier: number | null;
  mlStakeFraction: number | null;
  decision: string;
  permissionLevel: string;
  outcome: string;
  pnl: number | null;
  clvPct: number | null;
  settledAt: string | null;
  placementPlacedAt: string | null;
  placementStake: number | null;
  placementOdds: number | null;
  placementProviderTicketId: string | null;
  placementMode: string | null;
  placementPnl: number | null;
  placementClvPct: number | null;
  placementMlScore: number | null;
  placementMlModelEdgePct: number | null;
  placementMlDecision: string | null;
  placementMlKellyMultiplier: number | null;
  placementMlModelVersion: number | null;
  mlFeatures: number[] | null;
};

type PredictionAuditResponse = {
  rows: PredictionAuditRow[];
  total: number;
};

const CATEGORY_ORDER: RungCategory[] = [
  "data",
  "training",
  "inference",
  "quality",
];

const CATEGORY_LABEL: Record<RungCategory, string> = {
  data: "Data intake",
  training: "Training loop",
  inference: "Scoring path",
  quality: "Money gate",
};

export const ML_WORKSPACE_TABS = [
  {
    value: "overview",
    label: "Overview",
    icon: Gauge,
  },
  {
    value: "gateboard",
    label: "Gateboard",
    icon: GitBranch,
  },
  {
    value: "evaluation",
    label: "Evaluation",
    icon: BarChart3,
  },
  {
    value: "learning",
    label: "Learning",
    icon: BrainCircuit,
  },
  {
    value: "predictions",
    label: "Predictions",
    icon: Target,
  },
  {
    value: "models",
    label: "Models",
    icon: History,
  },
];

const STATUS_COPY: Record<RungStatus, string> = {
  pass: "Passing",
  warn: "Watch",
  fail: "Failing",
  pending: "Pending",
  blocked: "Blocked",
};

const DSR_EXPLANATION =
  "DSR is Deflated Sharpe Ratio: confidence that the model's betting edge is real after discounting for overfitting and repeated training trials. Deployment requires 0.6 or higher.";

export function MLHeaderSummary({ data, rungs }: Props) {
  const status = summarizeState(data, rungs);
  const StatusIcon = status.icon;
  const corpusPct = pct(
    data.dataCollection.currentCorpus.currentContractFeatures,
    data.dataCollection.currentCorpus.collectionTarget,
  );
  const coldStartPct = pct(
    data.dataCollection.currentCorpus.currentContractFeatures,
    data.dataCollection.currentCorpus.coldStartThreshold,
  );
  const blockedCount =
    countStatus(rungs, "fail") + countStatus(rungs, "blocked");
  const watchCount = countStatus(rungs, "warn") + countStatus(rungs, "pending");
  const activeTraining = data.training.activeTraining;

  return (
    <div className="hidden min-w-0 items-center gap-1.5 md:flex">
      <HeaderStatPill
        className={status.badge}
        icon={<StatusIcon className="size-3" />}
        label={status.label}
        hint={status.description}
      />
      <span className="hidden lg:inline-flex">
        <HeaderStatPill
          label="Corpus"
          value={`${formatInt(data.dataCollection.currentCorpus.currentContractFeatures)} / ${formatPct(corpusPct, 0)}`}
          hint="Current feature-contract corpus as a share of the collection target."
        />
      </span>
      <span className="hidden xl:inline-flex">
        <HeaderStatPill
          label="Cold"
          value={formatPct(coldStartPct, 0)}
          hint={`${formatInt(data.dataCollection.currentCorpus.remainingToColdStart)} current-contract rows remain before the cold-start threshold.`}
        />
      </span>
      <span className="hidden xl:inline-flex">
        <HeaderStatPill
          label="Model"
          value={
            data.deploymentGate.modelVersion == null
              ? "None"
              : `v${data.deploymentGate.modelVersion}`
          }
          hint={`Deployment permission: ${formatPermissionLevel(data.deploymentGate.permissionLevel)}.`}
        />
      </span>
      <span className="hidden 2xl:inline-flex">
        <HeaderStatPill
          label="Gates"
          value={`${formatInt(blockedCount)} blocked / ${formatInt(watchCount)} watch`}
          hint="Failing, blocked, warning, and pending gates across the pipeline."
        />
      </span>
      <span className="hidden 2xl:inline-flex">
        <HeaderStatPill
          label="Training"
          value={
            activeTraining
              ? `v${activeTraining.version} ${cleanText(activeTraining.trainingStage)}`
              : "Idle"
          }
          hint={
            activeTraining
              ? cleanText(
                  activeTraining.progressMessage ?? "Training is active.",
                )
              : `${formatInt(data.training.examplesUntilRetrain)} examples until retrain.`
          }
        />
      </span>
    </div>
  );
}

function HeaderStatPill({
  label,
  value,
  hint,
  icon,
  className,
}: {
  label: string;
  value?: string;
  hint: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex min-w-0 cursor-help items-center gap-1.5 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] leading-5 text-muted-foreground tabular-nums",
            className,
          )}
        >
          {icon}
          <span className="shrink-0">{label}</span>
          {value ? (
            <span className="truncate text-foreground/80">{value}</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-sm">{hint}</TooltipContent>
    </Tooltip>
  );
}

function MetricHint({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <p className="text-xs font-semibold uppercase tracking-[0.08em] text-foreground">
        {title}
      </p>
      <div className="space-y-1 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

export function MLControlRoom({ data, rungs }: Props) {
  const focusRung = useMemo(() => findFocusRung(rungs), [rungs]);
  const [selectedRungId, setSelectedRungId] = useState(
    focusRung?.definition.id ?? rungs[0]?.definition.id,
  );

  const selectedRung =
    rungs.find((rung) => rung.definition.id === selectedRungId) ??
    focusRung ??
    rungs[0];

  const groupedRungs = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        label: CATEGORY_LABEL[category],
        rungs: rungs.filter((rung) => rung.definition.category === category),
      })),
    [rungs],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <TabsContent
        value="overview"
        className="m-0 min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto grid w-full max-w-[1760px] gap-3 px-3 py-3 lg:px-5 2xl:px-6">
          <OverviewPanel data={data} rungs={rungs} focusRung={focusRung} />
        </div>
      </TabsContent>

      <TabsContent
        value="gateboard"
        className="m-0 min-h-0 flex-1 outline-none"
      >
        <div className="mx-auto w-full max-w-[1760px] px-3 py-3 lg:px-5 xl:h-full xl:min-h-0 2xl:px-6">
          <GateboardPanel
            data={data}
            groupedRungs={groupedRungs}
            selectedRung={selectedRung}
            selectedRungId={selectedRungId}
            onSelectRung={setSelectedRungId}
          />
        </div>
      </TabsContent>

      <TabsContent
        value="evaluation"
        className="m-0 min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[1760px] px-3 py-3 lg:px-5 2xl:px-6">
          <EvaluationPanel data={data} />
        </div>
      </TabsContent>

      <TabsContent
        value="learning"
        className="m-0 min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[1760px] px-3 py-3 lg:px-5 2xl:px-6">
          <MLLearningPanel />
        </div>
      </TabsContent>

      <TabsContent
        value="predictions"
        className="m-0 flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="flex min-h-0 flex-1 overflow-hidden px-2 py-2 lg:px-3">
          <PredictionAuditPanel />
        </div>
      </TabsContent>

      <TabsContent
        value="models"
        className="m-0 min-h-0 flex-1 overflow-y-auto outline-none"
      >
        <div className="mx-auto w-full max-w-[1760px] px-3 py-3 lg:px-5 2xl:px-6">
          <ModelsPanel data={data} />
        </div>
      </TabsContent>
    </div>
  );
}

function OverviewPanel({
  data,
  rungs,
  focusRung,
}: {
  data: PipelineData;
  rungs: EvaluatedRung[];
  focusRung: EvaluatedRung | undefined;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
      <main className="grid gap-3">
        <TrainingOperationsPanel data={data} />

        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={Database}
            title="Corpus accounting"
            description="Raw collection progress stays separate from trainer-readiness counts."
          />
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <CorpusBlock
              label="Total settled"
              value={data.dataCollection.currentCorpus.totalSettled}
              detail="raw settlement corpus"
            />
            <CorpusBlock
              label="Current contract"
              value={data.dataCollection.currentCorpus.currentContractFeatures}
              detail="feature contract matches"
            />
            <CorpusBlock
              label="Wins"
              value={data.dataCollection.currentCorpus.wins}
              detail="current-contract labels"
              tone="good"
            />
            <CorpusBlock
              label="Losses"
              value={data.dataCollection.currentCorpus.losses}
              detail="current-contract labels"
              tone="bad"
            />
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            <TargetRail
              label="Cold-start unlock"
              value={data.dataCollection.currentCorpus.currentContractFeatures}
              target={data.dataCollection.currentCorpus.coldStartThreshold}
              remaining={data.dataCollection.currentCorpus.remainingToColdStart}
            />
            <TargetRail
              label="Collection target"
              value={data.dataCollection.currentCorpus.currentContractFeatures}
              target={data.dataCollection.currentCorpus.collectionTarget}
              remaining={data.dataCollection.currentCorpus.remainingToTarget}
            />
          </div>
        </section>

        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={GitBranch}
            title="Pipeline gate map"
            description="The first non-green gate is the next meaningful intervention."
          />
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {CATEGORY_ORDER.map((category) => (
              <PipelineGateStage
                key={category}
                label={CATEGORY_LABEL[category]}
                rungs={rungs.filter(
                  (rung) => rung.definition.category === category,
                )}
              />
            ))}
          </div>
        </section>
      </main>

      <aside className="grid gap-3">
        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={ShieldCheck}
            title="Deployment gate"
            description="Permission level and stake controls currently exposed to scoring."
          />
          <div className="mt-3 grid gap-2">
            <KeyValue
              label="Permission"
              value={formatPermissionLevel(data.deploymentGate.permissionLevel)}
            />
            <KeyValue
              label="Policy edge"
              value={formatPct(data.deploymentGate.policyEdgeThresholdPct)}
            />
            <KeyValue
              label="Can gate"
              value={data.deploymentGate.canGate ? "Yes" : "No"}
            />
            <KeyValue
              label="Stake increase"
              value={data.deploymentGate.canIncreaseStake ? "Yes" : "No"}
            />
          </div>
        </section>

        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={Zap}
            title="Next action"
            description="Actionable gate evidence, not a generated checklist."
          />
          {focusRung ? (
            <RungBrief rung={focusRung} data={data} />
          ) : (
            <p className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
              No blocking rung. Keep watching latest predictions before raising
              stake permissions.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

function TrainingOperationsPanel({ data }: { data: PipelineData }) {
  const active = data.training.activeTraining;

  return (
    <section className="rounded-md border border-border bg-card p-3 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <SectionHeader
          icon={Activity}
          title="Training operations"
          description={
            active
              ? "Live run feedback from the training row the engine polls."
              : "Automatic retraining threshold, scheduler health, and run readiness."
          }
        />
        <TrainingStatusBadge data={data} />
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.82fr)]">
        <AutoRetrainCard data={data} />
        <LiveTrainingCard data={data} />
      </div>
    </section>
  );
}

function TrainingStatusBadge({ data }: { data: PipelineData }) {
  const active = data.training.activeTraining;
  const tone = active
    ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
    : data.training.readyToRetrain
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : data.scheduler.active
        ? "border-border bg-background text-muted-foreground"
        : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";

  return (
    <Badge
      variant="outline"
      className={cn("h-6 w-fit rounded-md px-2 text-xs", tone)}
    >
      {active
        ? "Training running"
        : data.training.readyToRetrain
          ? "Queued on next tick"
          : data.scheduler.active
            ? "Watching corpus"
            : "Scheduler stopped"}
    </Badge>
  );
}

function AutoRetrainCard({ data }: { data: PipelineData }) {
  const state = getAutoRetrainState(data);
  const schedulerTone = data.scheduler.active
    ? data.scheduler.lastError
      ? "warn"
      : "good"
    : "bad";

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Next automatic retrain</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {state.message}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn("h-5 shrink-0 rounded-md text-xs", state.badge)}
        >
          {state.label}
        </Badge>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-muted-foreground">
            {state.railLabel}
          </p>
          <p className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatInt(state.value)} / {formatInt(state.target)}
          </p>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-sm bg-muted">
          <div
            className={cn("h-full rounded-sm transition-all", state.bar)}
            style={{ width: `${Math.min(100, state.progress)}%` }}
          />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <MiniStat
          label="New examples"
          value={formatInt(data.training.newDataSinceLastTrain)}
        />
        <MiniStat
          label="Remaining"
          value={formatInt(state.remaining)}
          tone={state.remaining === 0 ? "good" : "neutral"}
        />
        <MiniStat label="Step" value={formatInt(data.training.retrainStep)} />
        <MiniStat
          label="Scheduler"
          value={data.scheduler.active ? "Active" : "Stopped"}
          tone={schedulerTone}
        />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <KeyValue
          label="Last tick"
          value={
            data.scheduler.lastTickAt == null
              ? "No tick"
              : formatAge(data.generatedAtMs - data.scheduler.lastTickAt)
          }
          tone={schedulerLastTickTone(
            data.scheduler.lastTickAt,
            data.generatedAtMs,
          )}
        />
        <KeyValue
          label="Triggers since boot"
          value={formatInt(data.scheduler.totalRetrainTriggers)}
        />
      </div>
      {data.scheduler.lastError ? (
        <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm leading-relaxed text-amber-800 dark:text-amber-200">
          {cleanText(data.scheduler.lastError)}
        </p>
      ) : null}
    </div>
  );
}

function LiveTrainingCard({ data }: { data: PipelineData }) {
  const active = data.training.activeTraining;

  if (!active) {
    return (
      <div className="rounded-md border border-border bg-background p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Live training feedback</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              No model is training right now. This panel switches to heartbeat,
              stage, elapsed time, and ETA as soon as a row enters training.
            </p>
          </div>
          <CircleDashed className="mt-0.5 size-4 text-muted-foreground" />
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          <KeyValue
            label="Active runs"
            value={formatInt(data.training.modelsInTraining)}
          />
          <KeyValue
            label="Auto-refresh"
            value={data.training.modelsInTraining ? "3 sec" : "15 sec"}
          />
        </div>
      </div>
    );
  }

  const stage = normalizeTrainingStage(active.trainingStage);
  const stageIndex = TRAINING_STAGES.findIndex((item) => item.id === stage);
  const heartbeatAgeMs = active.lastHeartbeatAt
    ? data.generatedAtMs - new Date(active.lastHeartbeatAt).getTime()
    : null;
  const staleHeartbeat =
    heartbeatAgeMs != null && Number.isFinite(heartbeatAgeMs)
      ? heartbeatAgeMs > 10 * 60_000
      : false;

  return (
    <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-cyan-600 dark:text-cyan-300" />
            <p className="text-sm font-semibold">
              {formatTrainingRunLabel(active)}
            </p>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {cleanText(active.progressMessage ?? stage)}
          </p>
        </div>
        <Badge
          variant="outline"
          className="h-5 shrink-0 rounded-md border-cyan-500/30 bg-cyan-500/10 text-xs text-cyan-700 dark:text-cyan-300"
        >
          {cleanText(stage)}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-8 gap-1">
        {TRAINING_STAGES.map((item, index) => (
          <Tooltip key={item.id}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "h-2 rounded-sm",
                  index <= stageIndex
                    ? "bg-cyan-500"
                    : "bg-muted-foreground/20",
                )}
                aria-label={`${item.label} stage ${index <= stageIndex ? "reached" : "pending"}`}
              />
            </TooltipTrigger>
            <TooltipContent className="text-sm">{item.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <MiniStat label="Samples" value={formatInt(active.sampleCount)} />
        <MiniStat
          label="Elapsed"
          value={formatDurationMs(active.elapsedMs)}
        />
        <MiniStat
          label="Heartbeat"
          value={heartbeatAgeMs == null ? "-" : formatAge(heartbeatAgeMs)}
          tone={staleHeartbeat ? "warn" : "good"}
        />
        <MiniStat
          label="ETA"
          value={formatDurationMs(active.estimatedRemainingMs)}
        />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <KeyValue label="Started" value={formatDate(active.startedAt)} />
        <KeyValue
          label="Last heartbeat"
          value={formatDate(active.lastHeartbeatAt)}
          tone={staleHeartbeat ? "warn" : "good"}
        />
      </div>
    </div>
  );
}

function PipelineGateStage({
  label,
  rungs,
}: {
  label: string;
  rungs: EvaluatedRung[];
}) {
  const bad = rungs.filter(
    (rung) =>
      rung.verdict.status === "fail" || rung.verdict.status === "blocked",
  ).length;
  const warn = rungs.filter(
    (rung) =>
      rung.verdict.status === "warn" || rung.verdict.status === "pending",
  ).length;
  const focusRung =
    rungs.find((rung) => rung.verdict.status !== "pass") ?? rungs[0];
  const gateCountLabel = `${rungs.length} ${rungs.length === 1 ? "gate" : "gates"}`;

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{label}</p>
          <p className="mt-0.5 font-mono text-[11px] uppercase text-muted-foreground">
            {gateCountLabel}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "h-5 rounded-md px-1.5 text-xs",
            bad > 0
              ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
              : warn > 0
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          {bad > 0 ? "Blocked" : warn > 0 ? "Watch" : "Clear"}
        </Badge>
      </div>

      <div aria-label={`${label} gate status`} className="mt-3 flex gap-1">
        {rungs.map((rung) => (
          <Tooltip key={rung.definition.id}>
            <TooltipTrigger asChild>
              <span
                aria-label={`${gateCode(rung.definition.number)} ${cleanText(rung.definition.title)} is ${STATUS_COPY[rung.verdict.status]}`}
                className={cn(
                  "h-2 min-w-0 flex-1 rounded-sm",
                  statusTone(rung.verdict.status).bar,
                )}
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-[280px] text-sm">
              {gateCode(rung.definition.number)}{" "}
              {cleanText(rung.definition.title)}:{" "}
              {STATUS_COPY[rung.verdict.status]}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="mt-1.5 flex gap-1">
        {rungs.map((rung) => (
          <span
            key={rung.definition.id}
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-[10px] uppercase",
              rung.verdict.status === "pass"
                ? "text-emerald-700 dark:text-emerald-300"
                : rung.verdict.status === "warn" ||
                    rung.verdict.status === "pending"
                  ? "text-amber-700 dark:text-amber-300"
                  : rung.verdict.status === "fail"
                    ? "text-rose-700 dark:text-rose-300"
                    : "text-muted-foreground",
            )}
          >
            {gateCode(rung.definition.number)}
          </span>
        ))}
      </div>

      <p className="mt-2 truncate text-sm text-muted-foreground">
        {focusRung
          ? `${gateCode(focusRung.definition.number)} ${cleanText(focusRung.definition.title)}`
          : "No gates configured"}
      </p>
    </div>
  );
}

function GateboardPanel({
  data,
  groupedRungs,
  selectedRung,
  selectedRungId,
  onSelectRung,
}: {
  data: PipelineData;
  groupedRungs: {
    category: RungCategory;
    label: string;
    rungs: EvaluatedRung[];
  }[];
  selectedRung: EvaluatedRung | undefined;
  selectedRungId: string | undefined;
  onSelectRung: (id: string) => void;
}) {
  return (
    <div className="grid gap-3 xl:h-full xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_420px]">
      <main className="grid content-start gap-3 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
        {groupedRungs.map((group) => (
          <section
            key={group.category}
            className="rounded-md border border-border bg-card p-3 shadow-sm"
          >
            <div>
              <h2 className="text-sm font-semibold">{group.label}</h2>
              <p className="text-sm text-muted-foreground">
                {group.rungs.length} checks in this stage.
              </p>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
              {group.rungs.map((rung) => (
                <Tooltip key={rung.definition.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onSelectRung(rung.definition.id)}
                      className={cn(
                        "min-h-[118px] rounded-md border bg-background p-3 text-left transition hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedRungId === rung.definition.id
                          ? "border-primary"
                          : "border-border",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-mono text-xs text-muted-foreground">
                            {gateCode(rung.definition.number)}
                          </p>
                          <h3 className="mt-1 line-clamp-2 text-sm font-semibold">
                            {cleanText(rung.definition.title)}
                          </h3>
                        </div>
                        <StatusBadge status={rung.verdict.status} />
                      </div>
                      <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                        {cleanText(
                          rung.verdict.secondary ?? rung.verdict.primary,
                        )}
                      </p>
                      {rung.verdict.action ? (
                        <p className="mt-2 line-clamp-1 text-xs font-medium text-foreground">
                          {cleanText(rung.verdict.action)}
                        </p>
                      ) : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[320px] text-sm">
                    Inspect {gateCode(rung.definition.number)} evidence and
                    operator actions.
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </section>
        ))}
      </main>

      <aside className="xl:min-h-0">
        {selectedRung ? (
          <RungInspector
            rung={selectedRung}
            data={data}
            className="xl:h-full xl:min-h-0"
          />
        ) : (
          <section className="rounded-md border border-border bg-card p-3 shadow-sm xl:h-full">
            <p className="text-sm text-muted-foreground">
              Select a gate to inspect its evidence.
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}

function EvaluationPanel({ data }: { data: PipelineData }) {
  const metrics = data.paperEvaluation.metrics;

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <main className="grid gap-3">
        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={BarChart3}
            title="Historical evaluation"
            description="The ML gate must beat the simple EV core before permissions increase."
          />
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Detected baseline"
              metric={metrics.detectedBaseline}
            />
            <MetricCard label="Simple EV core" metric={metrics.simpleEvCore} />
            <MetricCard label="ML scored" metric={metrics.mlScored} />
            <MetricCard label="ML gate" metric={metrics.mlGate} accent />
          </div>
        </section>

        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={Target}
            title="Recent ROI trend"
            description="Daily ROI from historical settled bets, comparing raw candidates, fixed rules, and ML-approved bets."
          />
          <TrendBars data={data} />
        </section>

        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={SlidersHorizontal}
            title="Score bucket return"
            description="Bucket-level ROI and CLV show where the model is actually useful."
          />
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.scoreBucketROI.length > 0 ? (
              data.scoreBucketROI.map((bucket) => (
                <div
                  key={bucket.bucket}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-semibold">
                      {cleanText(bucket.bucket)}
                    </p>
                    <Badge variant="outline" className="h-5 rounded-md text-xs">
                      n={formatInt(bucket.count)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <MiniStat
                      label="ROI"
                      value={formatPct(bucket.avgPnl)}
                      tone={signedTone(bucket.avgPnl)}
                    />
                    <MiniStat
                      label="CLV"
                      value={formatPct(bucket.avgClv)}
                      tone={signedTone(bucket.avgClv)}
                    />
                    <MiniStat
                      label="Win"
                      value={formatPct(bucket.winRate)}
                      tone={winRateTone(bucket.winRate)}
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyBlock text="No score bucket ROI is available yet." />
            )}
          </div>
        </section>
      </main>

      <aside className="grid gap-3">
        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={CheckCircle2}
            title="Semantic health"
            description="Feature contract checks that protect the trainer from polluted labels."
          />
          <div className="mt-3 grid gap-2">
            {Object.entries(data.paperEvaluation.semanticHealth).map(
              ([key, value]) => (
                <KeyValue
                  key={key}
                  label={formatRungInputLabel(key)}
                  value={formatRungInputValue(key, String(value))}
                  tone={semanticHealthTone(key, value)}
                />
              ),
            )}
          </div>
        </section>
        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={BrainCircuit}
            title="Verdict"
            description="Simple gates used before the model influences stake sizing."
          />
          <div className="mt-3 grid gap-2">
            <KeyValue
              label="Enough ML gate samples"
              value={
                data.paperEvaluation.verdict.enoughMlGateSamples ? "Yes" : "No"
              }
              tone={
                data.paperEvaluation.verdict.enoughMlGateSamples
                  ? "good"
                  : "bad"
              }
            />
            <KeyValue
              label="Beats simple rule"
              value={
                data.paperEvaluation.verdict.mlBeatsSimpleRule ? "Yes" : "No"
              }
              tone={
                data.paperEvaluation.verdict.mlBeatsSimpleRule ? "good" : "bad"
              }
            />
            <KeyValue
              label="ML minus simple ROI"
              value={formatPct(
                data.paperEvaluation.verdict.mlMinusSimpleRoiPct,
              )}
              tone={signedTone(
                data.paperEvaluation.verdict.mlMinusSimpleRoiPct,
              )}
            />
          </div>
        </section>
      </aside>
    </div>
  );
}

function PredictionAuditPanel() {
  const [search, setSearch] = useState("");
  const [decision, setDecision] = useState("all");
  const [settled, setSettled] = useState("all");

  const PAGE_SIZE = 100;

  const baseParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    if (search.trim()) params.set("search", search.trim());
    if (decision !== "all") params.set("decision", decision);
    if (settled !== "all") params.set("settled", settled);
    return params.toString();
  }, [decision, search, settled]);

  const {
    data,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useInfiniteQuery<PredictionAuditResponse>({
    queryKey: ["ml", "predictions", baseParams],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(baseParams);
      params.set("offset", String(pageParam));
      const res = await fetch(`/api/ml/predictions?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.rows.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    refetchInterval: 15000,
    retry: 1,
  });

  const rows = useMemo(
    () => data?.pages.flatMap((page) => page.rows) ?? [],
    [data],
  );
  const total = data?.pages[0]?.total ?? 0;
  const columns = useMemo<ColumnDef<PredictionAuditRow>[]>(
    () => [
      {
        id: "predicted",
        header: "Predicted",
        accessorKey: "scoredAt",
        cell: ({ row }) => (
          <span className="text-muted-foreground text-[10px]">
            {fmtSeen(row.original.scoredAt)}
          </span>
        ),
        meta: {
          align: "center",
          initialSize: 70,
          hint: "Timestamp when ML predicted this bet.",
        },
      },
      {
        id: "ko",
        header: "KO",
        accessorKey: "eventStartTime",
        cell: ({ row }) => (
          <span className="text-[10px] text-muted-foreground">
            {fmtDateTime(row.original.eventStartTime)}
          </span>
        ),
        meta: {
          align: "center",
          initialSize: 92,
          hint: "Kickoff time for the event attached to this prediction.",
        },
      },
      {
        id: "event",
        header: "Event",
        accessorFn: (row) => `${row.homeTeam} vs ${row.awayTeam}`,
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="max-w-[260px] flex items-center gap-1.5 min-w-0 cursor-default">
                <span className="font-medium truncate">
                  {row.original.homeTeam}
                </span>
                <span className="text-muted-foreground shrink-0">vs</span>
                <span className="font-medium truncate">
                  {row.original.awayTeam}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[320px] p-2.5">
              <div className="space-y-1 text-xs">
                <p className="font-medium">
                  {row.original.homeTeam} vs {row.original.awayTeam}
                </p>
                <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                  <span>League</span>
                  <span className="text-foreground">
                    {row.original.competition || "Unknown"}
                  </span>
                  <span>Kickoff</span>
                  <span className="text-foreground">
                    {fmtDateTime(row.original.eventStartTime)}
                  </span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        ),
        meta: {
          initialSize: 230,
          hint: "Home team and away team. Hover for league and kickoff.",
        },
      },
      {
        id: "market",
        header: "Market",
        cell: ({ row }) => (
          <MarketDisplay
            marketType={row.original.marketType}
            timeScope={row.original.timeScope}
            familyLine={row.original.familyLine}
            className="max-w-full text-[11px]"
          />
        ),
        meta: {
          align: "center",
          initialSize: 128,
          hint: "Market type and scope scored by ML.",
        },
      },
      {
        id: "outcome",
        header: "Outcome",
        accessorKey: "atomLabel",
        cell: ({ row }) => formatAtomLabel(row.original.atomLabel),
        meta: {
          align: "center",
          initialSize: 82,
          hint: "Selection side the model evaluated.",
        },
      },
      {
        id: "sharp",
        header: "Sharp",
        accessorKey: "sharpOdds",
        cell: ({ row }) => (
          <ProviderOdds
            provider={row.original.sharpProvider}
            odds={row.original.sharpOdds}
          />
        ),
        meta: {
          align: "center",
          initialSize: 78,
          hint: "Sharp reference price used as the benchmark.",
        },
      },
      {
        id: "soft",
        header: "Soft",
        accessorKey: "softOdds",
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 cursor-help">
                <ProviderOdds
                  provider={row.original.softProvider}
                  odds={row.original.softOdds}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="px-3 py-2">
              <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
                <span className="opacity-60">Entry price</span>
                <span className="text-right font-medium">
                  {row.original.softOdds.toFixed(2)}
                </span>
                <span className="opacity-60">Commission</span>
                <span className="text-right">
                  {row.original.softCommissionPct.toFixed(2)}%
                </span>
              </div>
            </TooltipContent>
          </Tooltip>
        ),
        meta: {
          align: "center",
          initialSize: 78,
          hint: "Soft bookmaker price at prediction time.",
        },
      },
      {
        id: "baselineEv",
        header: "EV %",
        accessorKey: "baselineEvPct",
        cell: ({ row }) => {
          const ev = row.original.baselineEvPct;
          const high = ev != null && ev >= 5;
          const medium = ev != null && ev >= 2 && ev < 5;
          return (
            <span
              className={cn(
                "inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                high &&
                  "bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 dark:text-emerald-300",
                medium &&
                  "bg-amber-500/15 text-amber-700 border border-amber-500/30 dark:text-amber-300",
                !high &&
                  !medium &&
                  "bg-muted text-muted-foreground border border-border",
              )}
            >
              {formatPct(ev, 2)}
            </span>
          );
        },
        meta: {
          align: "center",
          initialSize: 72,
          hint: "Baseline expected value before the ML gate changes stake.",
        },
      },
      {
        id: "ml",
        header: "ML",
        accessorKey: "mlScore",
        cell: ({ row }) => (
          <div className="font-mono text-[11px] tabular-nums">
            <span className="font-semibold">
              {row.original.mlScore.toFixed(3)}
            </span>
            <span
              className={cn(
                "ml-1.5",
                valueToneClass(signedTone(row.original.modelEdgePct)),
              )}
            >
              {formatPct(row.original.modelEdgePct, 2)}
            </span>
          </div>
        ),
        meta: {
          align: "center",
          initialSize: 86,
          hint: "Model score and model edge for the selection.",
        },
      },
      {
        id: "stake",
        header: "Stake",
        accessorKey: "mlStakeFraction",
        cell: ({ row }) => (
          <div className="font-mono text-[11px] tabular-nums">
            <span className="font-semibold">
              {formatStake(row.original.mlStakeFraction)}
            </span>
            <p className="text-muted-foreground">
              {formatMultiplier(row.original.kellyMultiplier)}
            </p>
          </div>
        ),
        meta: {
          align: "center",
          initialSize: 78,
          hint: "ML stake fraction and Kelly multiplier after gate policy.",
        },
      },
      {
        id: "gate",
        header: "Gate",
        accessorKey: "decision",
        cell: ({ row }) => {
          const r = row.original;
          const features = r.mlFeatures ?? [];
          const multiplier = r.kellyMultiplier ?? 1.0;
          const reason = buildDecisionReason(r.mlScore, features, multiplier, undefined, {
            homeTeam: r.homeTeam,
            awayTeam: r.awayTeam,
            marketType: r.marketType,
            atomLabel: r.atomLabel,
          });

          return (
            <Dialog>
              <DialogTrigger asChild>
                <div className="inline-flex cursor-pointer items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-5 rounded-md px-1.5 text-xs capitalize",
                      decisionTone(r.decision),
                    )}
                  >
                    {cleanText(r.decision)}
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {r.modelVersion == null ? "shadow" : `v${r.modelVersion}`}
                  </span>
                </div>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <div className="flex items-center justify-between">
                    <DialogTitle className="text-base">Decision Analysis</DialogTitle>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-6 rounded-md px-2 text-sm capitalize",
                        decisionTone(r.decision),
                      )}
                    >
                      {cleanText(r.decision)}
                    </Badge>
                  </div>
                </DialogHeader>

                <div className="space-y-5 text-sm">
                  <div className="rounded-md bg-muted/40 p-4">
                    <p className="font-medium text-foreground leading-relaxed">
                      {reason.summary}
                    </p>
                  </div>

                  <div>
                    <p className="mb-3 font-semibold text-foreground">Why this decision?</p>
                    <ul className="space-y-3">
                      {reason.explanation.map((point, i) => (
                        <li key={i} className="flex gap-3">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
                          <div>
                            <span className="font-semibold text-foreground">{point.heading}: </span>
                            <span className="text-muted-foreground leading-relaxed">{point.text}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {reason.multiplierChain !== "1.0 = 1.00× (no adjustments needed)" && (
                    <div className="rounded-md border border-border bg-muted/30 p-3">
                      <p className="mb-2 font-semibold text-foreground">Multiplier Chain</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {reason.multiplierChain}
                      </p>
                    </div>
                  )}

                  <div>
                    <p className="mb-3 font-semibold text-foreground">Technical Signals</p>
                    <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                      {reason.technical.map((tech, i) => (
                        <div key={i} className="contents">
                          <span className="text-muted-foreground font-medium">{tech.label}</span>
                          <div className="flex flex-col">
                            <span
                              className={cn(
                                "font-mono font-medium",
                                tech.tone === "positive"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : tech.tone === "negative"
                                    ? "text-rose-600 dark:text-rose-400"
                                    : "text-foreground",
                              )}
                            >
                              {tech.value}
                            </span>
                            <span className="text-[11px] text-muted-foreground/80 leading-snug">
                              {tech.detail}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          );
        },
        meta: {
          align: "center",
          initialSize: 118,
          hint: "Click to open a detailed modal with decision analysis and technical signals.",
        },
      },
      {
        id: "placement",
        header: "Placement",
        accessorKey: "placementMlDecision",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.placementPlacedAt) {
            return <span className="text-muted-foreground/40">—</span>;
          }

          const decision = r.placementMlDecision ?? "none";
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="inline-flex cursor-help items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-5 rounded-md px-1.5 text-xs capitalize tabular-nums",
                      decisionTone(decision),
                    )}
                  >
                    {cleanText(decision)}
                  </Badge>
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums",
                      valueToneClass(signedTone(r.placementMlModelEdgePct)),
                    )}
                  >
                    {formatPct(r.placementMlModelEdgePct, 1)}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[320px] p-2.5">
                <div className="space-y-2 text-xs">
                  <div>
                    <p className="mb-1 font-medium text-foreground">
                      Placement ML
                    </p>
                    <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                      <span>Decision</span>
                      <span className="capitalize text-foreground">
                        {cleanText(r.placementMlDecision ?? "no snapshot")}
                      </span>
                      <span>Score</span>
                      <span className="font-mono text-foreground">
                        {formatDecimal(r.placementMlScore, 3)}
                      </span>
                      <span>Model EV</span>
                      <span className="font-mono text-foreground">
                        {formatPct(r.placementMlModelEdgePct, 2)}
                      </span>
                      <span>Multiplier</span>
                      <span className="font-mono text-foreground">
                        {formatMultiplier(r.placementMlKellyMultiplier)}
                      </span>
                      <span>Model</span>
                      <span className="font-mono text-foreground">
                        {r.placementMlModelVersion == null
                          ? "-"
                          : `v${r.placementMlModelVersion}`}
                      </span>
                      <span>Booked</span>
                      <span className="font-mono text-foreground">
                        {r.placementOdds == null
                          ? "-"
                          : r.placementOdds.toFixed(2)}
                      </span>
                      <span>Stake</span>
                      <span className="font-mono text-foreground">
                        {r.placementStake == null
                          ? "-"
                          : r.placementStake.toFixed(2)}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-border pt-2">
                    <p className="mb-1 font-medium text-foreground">
                      Latest ML
                    </p>
                    <div className="grid grid-cols-[86px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-muted-foreground">
                      <span>Decision</span>
                      <span className="capitalize text-foreground">
                        {cleanText(r.decision)}
                      </span>
                      <span>Score</span>
                      <span className="font-mono text-foreground">
                        {formatDecimal(r.mlScore, 3)}
                      </span>
                      <span>Model EV</span>
                      <span className="font-mono text-foreground">
                        {formatPct(r.modelEdgePct, 2)}
                      </span>
                      <span>Stake</span>
                      <span className="font-mono text-foreground">
                        {formatStake(r.mlStakeFraction)}
                      </span>
                    </div>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          );
        },
        meta: {
          align: "center",
          initialSize: 118,
          hint: "Frozen placement-time ML snapshot from bets, separate from latest prediction columns.",
        },
      },
      {
        id: "result",
        header: "Result",
        accessorKey: "outcome",
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="inline-flex cursor-help items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 rounded-md px-1.5 text-xs capitalize",
                    outcomeTone(row.original.outcome),
                  )}
                >
                  {cleanText(row.original.outcome)}
                </Badge>
                <span
                  className={cn(
                    "font-mono text-[10px] tabular-nums",
                    valueToneClass(signedTone(row.original.pnl)),
                  )}
                >
                  {row.original.pnl == null ? "-" : row.original.pnl.toFixed(2)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px] p-2.5">
              <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <span>Outcome</span>
                <span className="text-foreground">
                  {cleanText(row.original.outcome)}
                </span>
                <span>PnL</span>
                <span className={valueToneClass(signedTone(row.original.pnl))}>
                  {row.original.pnl == null ? "-" : row.original.pnl.toFixed(2)}
                </span>
                <span>CLV</span>
                <span
                  className={valueToneClass(signedTone(row.original.clvPct))}
                >
                  {formatPct(row.original.clvPct, 2)}
                </span>
                <span>Predicted</span>
                <span className="text-foreground">
                  {format(
                    new Date(row.original.scoredAt),
                    "MMM d, yyyy HH:mm:ss",
                  )}
                </span>
                <span>Settled</span>
                <span className="text-foreground">
                  {row.original.settledAt
                    ? format(
                        new Date(row.original.settledAt),
                        "MMM d, yyyy HH:mm:ss",
                      )
                    : "-"}
                </span>
              </div>
            </TooltipContent>
          </Tooltip>
        ),
        meta: {
          align: "center",
          initialSize: 112,
          hint: "Settlement outcome and mirrored profit or loss.",
        },
      },
    ],
    [],
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border p-3 xl:flex-row xl:items-center xl:justify-between">
        <SectionHeader
          icon={Target}
          title="Latest predictions"
          description="One row per bet with current model score, price context, gate action, and settlement."
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">
            {formatInt(rows.length)}/{formatInt(total)}
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="relative w-full sm:w-[260px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search team or market"
                  className="h-8 pl-8 text-sm"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-sm">
              Filter predictions by team, market, selection, or competition.
            </TooltipContent>
          </Tooltip>

          <SelectControl
            value={decision}
            onValueChange={setDecision}
            width="w-[136px]"
            hint="Filter by model decision."
            options={[
              ["all", "All decisions"],
              ["boost", "Boost"],
              ["agree", "Agree"],
              ["shrink", "Shrink"],
              ["skip", "Skip"],
            ]}
          />

          <SelectControl
            value={settled}
            onValueChange={setSettled}
            width="w-[124px]"
            hint="Filter by settlement state."
            options={[
              ["all", "All rows"],
              ["pending", "Pending"],
              ["settled", "Settled"],
            ]}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="h-8 text-xs"
              >
                <RefreshCw
                  className={cn("size-3.5", isFetching && "animate-spin")}
                />
                Refresh
              </Button>
            </TooltipTrigger>
            <TooltipContent className="text-sm">
              Refresh latest prediction rows.
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <DataTable<PredictionAuditRow>
        data={rows}
        columns={columns}
        getRowId={(row) => String(row.id)}
        enableSorting
        enableColumnResizing
        enableColumnOrdering
        density="compact"
        loading={isFetching && rows.length === 0}
        rowHeight={30}
        persistenceKey="ml-prediction-audit-v5"
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={() => void fetchNextPage()}
        renderEmpty={() => (
          <EmptyBlock text="No prediction rows match the current filters." />
        )}
        renderLoading={() => (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Loading latest predictions...
          </span>
        )}
        renderFooter={() => (
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{formatInt(total)} matching predictions</span>
            {isFetching ? <span>Refreshing...</span> : null}
          </div>
        )}
      />
    </section>
  );
}

function ModelsPanel({ data }: { data: PipelineData }) {
  const columns = useMemo<ColumnDef<ModelRow>[]>(
    () => [
      {
        id: "version",
        header: "Version",
        cell: ({ row }) => (
          <span className="font-mono text-[11px]">v{row.original.version}</span>
        ),
        meta: { initialSize: 80 },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={cn(
              "h-5 rounded-md px-1.5 text-xs capitalize",
              modelTone(row.original.status),
            )}
          >
            {cleanText(row.original.status)}
          </Badge>
        ),
        meta: { initialSize: 105 },
      },
      {
        id: "samples",
        header: "Samples",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] tabular-nums">
            {formatInt(row.original.trainingSamples)}
          </span>
        ),
        meta: { align: "right", initialSize: 90 },
      },
      {
        id: "auc",
        header: "AUC",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] tabular-nums">
            {formatDecimal(row.original.oosAucRoc)}
          </span>
        ),
        meta: {
          align: "right",
          initialSize: 80,
          hint: (
            <MetricHint title="AUC">
              <p>Out-of-sample ranking quality for win/loss prediction.</p>
              <p>
                0.5 is random. Higher is better, but AUC alone does not prove
                profitable betting.
              </p>
            </MetricHint>
          ),
        },
      },
      {
        id: "dsr",
        header: "DSR",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] tabular-nums">
            {formatDecimal(row.original.deflatedSharpe)}
          </span>
        ),
        meta: {
          align: "right",
          initialSize: 80,
          hint: (
            <MetricHint title="DSR">
              <p>{DSR_EXPLANATION}</p>
              <p>
                Low DSR usually means the CPCV policy returns are too weak, too
                noisy, or too likely to be a lucky HPO result.
              </p>
            </MetricHint>
          ),
        },
      },
      {
        id: "pbo",
        header: "PBO",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] tabular-nums">
            {formatPct(
              row.original.pbo == null ? null : row.original.pbo * 100,
            )}
          </span>
        ),
        meta: {
          align: "right",
          initialSize: 80,
          hint: (
            <MetricHint title="PBO">
              <p>Probability of backtest overfitting from CPCV return paths.</p>
              <p>
                Lower is better. In the current trainer this is warning-only
                because the runtime policy uses one fixed threshold.
              </p>
            </MetricHint>
          ),
        },
      },
      {
        id: "permission",
        header: "Permission",
        cell: ({ row }) => (
          <span className="text-xs">
            {formatPermissionLevel(row.original.permissionLevel)}
          </span>
        ),
        meta: { initialSize: 140 },
      },
      {
        id: "created",
        header: "Created",
        cell: ({ row }) => (
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatDate(row.original.createdAt)}
          </span>
        ),
        meta: { initialSize: 120 },
      },
    ],
    [],
  );

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <section className="overflow-hidden rounded-md border border-border bg-card shadow-sm">
        <div className="border-b border-border p-3">
          <SectionHeader
            icon={History}
            title="Model time machine"
            description="Every trained model version with metrics, permission, and lifecycle state."
          />
        </div>
        <DataTable<ModelRow>
          data={data.modelHistory}
          columns={columns}
          getRowId={(row) => String(row.version)}
          enableSorting
          enableColumnResizing
          density="compact"
          persistenceKey="ml-model-history-v2"
          renderEmpty={() => (
            <EmptyBlock text="No model history is available." />
          )}
        />
      </section>

      <aside className="grid gap-3">
        <section className="rounded-md border border-border bg-card p-3 shadow-sm">
          <SectionHeader
            icon={XCircle}
            title="Rejected candidates"
            description="Recent model rows that failed quality or deployment gates."
          />
          <div className="mt-3 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
            {DSR_EXPLANATION}
          </div>
          <div className="mt-3 grid gap-2">
            {data.rejectedModels.length > 0 ? (
              data.rejectedModels.slice(0, 6).map((model) => (
                <div
                  key={`${model.version}-${model.status}`}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs font-semibold">
                      v{model.version}
                    </p>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-5 rounded-md px-1.5 text-xs capitalize",
                        modelTone(model.status),
                      )}
                    >
                      {cleanText(model.status)}
                    </Badge>
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                    {model.reasons.length > 0
                      ? cleanText(model.reasons.join(" / "))
                      : "No rejection reason recorded."}
                  </p>
                </div>
              ))
            ) : (
              <EmptyBlock text="No rejected model candidates." />
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function RungInspector({
  rung,
  data,
  className,
}: {
  rung: EvaluatedRung;
  data: PipelineData;
  className?: string;
}) {
  const tone = statusTone(rung.verdict.status);
  const StatusIcon = tone.icon;
  const inputs = rung.definition.inputs?.(data) ?? [];
  const actions = (rung.definition.actions ?? []).filter(
    (action) => action.visibleWhen?.(data) ?? true,
  );

  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden rounded-md border border-border bg-card p-3 shadow-sm",
        className,
      )}
    >
      <div className="flex shrink-0 items-start gap-3">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md border",
            tone.iconBox,
          )}
        >
          <StatusIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-xs text-muted-foreground">
            {gateCode(rung.definition.number)}
          </p>
          <h2 className="mt-1 text-base font-semibold">
            {cleanText(rung.definition.title)}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {cleanText(rung.verdict.secondary ?? rung.verdict.primary)}
          </p>
        </div>
        <StatusBadge status={rung.verdict.status} />
      </div>

      <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-xs font-semibold text-muted-foreground">
            Why it matters
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            {cleanText(rung.definition.evidence.why)}
          </p>
        </div>

        {rung.verdict.action ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              Operator action
            </p>
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
              {cleanText(rung.verdict.action)}
            </p>
          </div>
        ) : null}

        <div className="grid gap-2">
          <p className="text-xs font-semibold text-muted-foreground">
            Live values
          </p>
          {inputs.length > 0 ? (
            inputs.map((input) => {
              const value = formatRungInputValue(
                input.label,
                cleanText(input.value),
              );
              return (
                <KeyValue
                  key={`${input.label}-${input.value}`}
                  label={formatRungInputLabel(input.label)}
                  value={value}
                  tone={rungInputTone(input.label, value)}
                />
              );
            })
          ) : (
            <EmptyBlock text="This gate does not expose extra inputs." />
          )}
        </div>
      </div>

      {actions.length > 0 ? (
        <div className="mt-3 grid shrink-0 gap-2 border-t border-border pt-3">
          <p className="text-xs font-semibold text-muted-foreground">Actions</p>
          {actions.map((action) => (
            <ActionButton key={action.id} action={action} data={data} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RungBrief({
  rung,
  data,
}: {
  rung: EvaluatedRung;
  data: PipelineData;
}) {
  const actions = (rung.definition.actions ?? []).filter(
    (action) => action.visibleWhen?.(data) ?? true,
  );

  return (
    <div className="mt-3 grid gap-2">
      <div className="rounded-md border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">
            {gateCode(rung.definition.number)}
          </p>
          <StatusBadge status={rung.verdict.status} />
        </div>
        <p className="mt-2 text-sm font-semibold">
          {cleanText(rung.definition.title)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {cleanText(
            rung.verdict.action ??
              rung.verdict.secondary ??
              rung.verdict.primary,
          )}
        </p>
      </div>
      {actions.slice(0, 2).map((action) => (
        <ActionButton key={action.id} action={action} data={data} compact />
      ))}
    </div>
  );
}

function ActionButton({
  action,
  data,
  compact = false,
}: {
  action: RungAction;
  data: PipelineData;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (action.confirm) {
      const ok = window.confirm(
        `${cleanText(action.confirm.title)}\n\n${cleanText(action.confirm.body)}`,
      );
      if (!ok) return;
    }

    setRunning(true);
    try {
      const res = await fetch(action.endpoint, {
        method: action.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.body?.(data) ?? {}),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        throw new Error((payload.error as string) ?? `HTTP ${res.status}`);
      }
      toast.success(`${action.label} succeeded`, {
        description: describeMutationResult(payload),
      });
      void qc.invalidateQueries({ queryKey: ["ml", "pipeline"] });
    } catch (err) {
      toast.error(`${action.label} failed`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-background p-3",
        compact && "p-2",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{cleanText(action.label)}</p>
          {!compact ? (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {cleanText(action.description)}
            </p>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant={
                action.intent === "destructive" ? "destructive" : "default"
              }
              disabled={running}
              onClick={() => void run()}
              className="h-8 shrink-0 text-xs"
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Run
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px] text-sm">
            {action.confirm
              ? "Ask for confirmation before running this action."
              : "Run this ML pipeline action."}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

const ROI_TREND_STRATEGIES: {
  key: RoiTrendStrategy;
  label: string;
  definition: string;
  color: string;
  className: string;
  strokeWidth: number;
  dash?: string;
}[] = [
  {
    key: "baseline",
    label: "Baseline",
    definition: "Default comparison result from the evaluated candidate set.",
    color: "rgb(148 163 184)",
    className: "bg-slate-400",
    strokeWidth: 1.5,
    dash: "4 4",
  },
  {
    key: "simple",
    label: "Simple rule",
    definition: "Fixed non-ML filter, such as edge or confidence thresholds.",
    color: "rgb(245 158 11)",
    className: "bg-amber-500",
    strokeWidth: 1.75,
  },
  {
    key: "mlGate",
    label: "ML gate",
    definition: "Model accept or reject filter. ROI uses accepted bets only.",
    color: "rgb(34 197 94)",
    className: "bg-emerald-500",
    strokeWidth: 2.5,
  },
];

const TRAINING_STAGES = [
  { id: "loading", label: "Loading" },
  { id: "hpo", label: "HPO" },
  { id: "holdout", label: "Holdout" },
  { id: "cpcv", label: "CPCV" },
  { id: "final", label: "Final fit" },
  { id: "gate", label: "Gate" },
  { id: "export", label: "Export" },
  { id: "complete", label: "Complete" },
] as const;

const ROI_TREND_KEYS: Record<
  RoiTrendStrategy,
  { roi: keyof RoiTrendRow; count: keyof RoiTrendRow }
> = {
  baseline: { roi: "baselineRoiPct", count: "baselineN" },
  simple: { roi: "simpleRoiPct", count: "simpleN" },
  mlGate: { roi: "mlGateRoiPct", count: "mlGateN" },
};

function TrendBars({ data }: { data: PipelineData }) {
  const rows = data.paperEvaluation.trend.slice(-14);
  const metrics = data.paperEvaluation.metrics;
  const evaluationDays = rows.length;
  const totalEvaluated = rows.reduce((sum, row) => sum + row.baselineN, 0);
  const acceptedBets = rows.reduce((sum, row) => sum + row.mlGateN, 0);

  if (rows.length === 0) {
    return (
      <div className="mt-3">
        <EmptyBlock text="No ROI trend yet. This chart appears after settled historical bets are available for evaluation." />
      </div>
    );
  }

  const chartData = rows.map((row) => ({
    ...row,
    label: format(new Date(row.day), "MMM d"),
  }));
  const verdict = data.paperEvaluation.verdict.mlBeatsSimpleRule
    ? "ML gate is ahead of the fixed rule on this evaluation."
    : "ML gate is not ahead of the fixed rule yet.";

  return (
    <div className="mt-3 grid gap-3">
      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-md border border-border bg-background p-3">
          <p className="text-xs font-semibold text-foreground">
            How to read this
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            ROI is profit divided by stake. Above 0% is profitable, below 0% is
            losing. The ML gate line shows only bets the model would have
            accepted.
          </p>
          <div className="mt-3 rounded-md border border-border bg-muted/25 p-2">
            <p className="text-xs font-semibold text-foreground">
              Sample size matters
            </p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              A high ROI over a few bets can be noise. Compare ROI with the
              accepted bet count before treating the model as better.
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-foreground">
                Key numbers
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{verdict}</p>
            </div>
            <Badge variant="outline" className="h-5 rounded-md text-xs">
              {formatInt(evaluationDays)} days
            </Badge>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <MiniStat
              label="ML gate ROI"
              value={formatPct(metrics.mlGate.roiPct)}
            />
            <MiniStat
              label="Simple rule ROI"
              value={formatPct(metrics.simpleEvCore.roiPct)}
            />
            <MiniStat
              label="Baseline ROI"
              value={formatPct(metrics.detectedBaseline.roiPct)}
            />
            <MiniStat
              label="ML accepted"
              value={`${formatInt(acceptedBets)} / ${formatInt(totalEvaluated)}`}
            />
          </div>
        </div>
      </div>

      <RoiTrendChart rows={chartData} />
      <RoiTrendLegend />
    </div>
  );
}

function RoiTrendChart({ rows }: { rows: RoiTrendPoint[] }) {
  return (
    <div className="h-[260px] rounded-md border border-border bg-background p-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 10, right: 12, bottom: 0, left: -6 }}
        >
          <CartesianGrid
            stroke="currentColor"
            strokeDasharray="3 3"
            opacity={0.08}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
            tickLine={false}
            axisLine={{ stroke: "currentColor", opacity: 0.16 }}
            minTickGap={18}
          />
          <YAxis
            tick={{ fill: "currentColor", fontSize: 10, opacity: 0.62 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) => `${value}%`}
            width={42}
          />
          <ReferenceLine
            y={0}
            stroke="currentColor"
            strokeDasharray="2 4"
            opacity={0.42}
          />
          <RechartsTooltip
            cursor={{
              stroke: "currentColor",
              strokeOpacity: 0.16,
              strokeDasharray: "3 3",
            }}
            content={<RoiTrendTooltip />}
          />
          {ROI_TREND_STRATEGIES.map((strategy) => (
            <Line
              key={strategy.key}
              type="monotone"
              dataKey={ROI_TREND_KEYS[strategy.key].roi}
              name={strategy.label}
              stroke={strategy.color}
              strokeWidth={strategy.strokeWidth}
              strokeDasharray={strategy.dash}
              dot={{ r: strategy.key === "mlGate" ? 2.5 : 2 }}
              activeDot={{ r: strategy.key === "mlGate" ? 4 : 3 }}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RoiTrendTooltip({
  active,
  payload,
}: Partial<TooltipContentProps<number, string>>) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as RoiTrendPoint | undefined;
  if (!row) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="font-semibold">{format(new Date(row.day), "MMM d")}</p>
      <div className="mt-2 grid gap-1.5">
        {ROI_TREND_STRATEGIES.map((strategy) => {
          const keys = ROI_TREND_KEYS[strategy.key];
          const roi = row[keys.roi] as number | null;
          const count = row[keys.count] as number;
          return (
            <div
              key={strategy.key}
              className="grid grid-cols-[84px_64px_56px] items-center gap-2"
            >
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-2 rounded-sm", strategy.className)} />
                {strategy.label}
              </span>
              <span className="text-right font-mono font-semibold tabular-nums">
                {formatPct(roi)}
              </span>
              <span className="text-right font-mono text-muted-foreground tabular-nums">
                n={formatInt(count)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoiTrendLegend() {
  return (
    <div className="grid gap-2 rounded-md border border-border bg-background p-3 md:grid-cols-3">
      {ROI_TREND_STRATEGIES.map((strategy) => (
        <Tooltip key={strategy.key}>
          <TooltipTrigger asChild>
            <div className="min-w-0 cursor-default">
              <div className="flex items-center gap-2">
                <span
                  className={cn("h-2 w-5 rounded-sm", strategy.className)}
                />
                <p className="text-xs font-semibold text-foreground">
                  {strategy.label}
                </p>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {strategy.definition}
              </p>
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-[280px] text-sm">
            {strategy.definition}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function MetricCard({
  label,
  metric,
  accent = false,
}: {
  label: string;
  metric: PaperMetric;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border bg-background p-3",
        accent ? "border-cyan-500/30" : "border-border",
      )}
    >
      <p className="text-sm font-semibold">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-xl font-semibold tabular-nums",
          valueToneClass(signedTone(metric.roiPct)),
        )}
      >
        {formatPct(metric.roiPct)}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <MiniStat label="N" value={formatInt(metric.sampleSize)} />
        <MiniStat
          label="Win"
          value={formatPct(metric.winRatePct)}
          tone={winRateTone(metric.winRatePct)}
        />
        <MiniStat
          label="EV"
          value={formatPct(metric.avgEvPct)}
          tone={signedTone(metric.avgEvPct)}
        />
      </div>
    </div>
  );
}

function TargetRail({
  label,
  value,
  target,
  remaining,
}: {
  label: string;
  value: number;
  target: number;
  remaining: number;
}) {
  const progress = pct(value, target);

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">{label}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {formatInt(value)} / {formatInt(target)}
        </p>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-sm bg-muted">
        <div
          className="h-full rounded-sm bg-cyan-500"
          style={{ width: `${Math.min(100, progress)}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {Math.max(0, remaining).toLocaleString()} examples remaining.
      </p>
    </div>
  );
}

function getAutoRetrainState(data: PipelineData) {
  const active = data.training.activeTraining;
  const qualified = data.dataCollection.qualifiedForTraining;
  const coldStart = data.dataCollection.coldStartThreshold;

  if (active) {
    const samples = Math.max(1, active.sampleCount);
    return {
      label: "Running",
      message:
        "A training run is active. The automatic queue waits for this row to finish before it can fire again.",
      railLabel: "Training sample set",
      value: samples,
      target: samples,
      remaining: 0,
      progress: 100,
      bar: "bg-cyan-500",
      badge:
        "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    };
  }

  if (qualified < coldStart) {
    const remaining = Math.max(0, coldStart - qualified);
    return {
      label: "Cold-start",
      message: `${formatInt(remaining)} trainer-ready examples before automatic training can start.`,
      railLabel: "Cold-start progress",
      value: qualified,
      target: coldStart,
      remaining,
      progress: pct(qualified, coldStart),
      bar: "bg-amber-500",
      badge:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }

  if (data.training.readyToRetrain) {
    return {
      label: "Queued",
      message: data.training.deployedModel
        ? "The growth threshold is met. The engine starts training on the next scheduler tick."
        : "Cold-start is satisfied and no model is deployed. The first training run starts on the next scheduler tick.",
      railLabel: "Retrain threshold",
      value: data.training.retrainStep,
      target: data.training.retrainStep,
      remaining: 0,
      progress: 100,
      bar: "bg-emerald-500",
      badge:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }

  return {
    label: "Waiting",
    message: `${formatInt(data.training.examplesUntilRetrain)} more trainer-ready examples until the next automatic retrain.`,
    railLabel: "New examples since baseline",
    value: data.training.newDataSinceLastTrain,
    target: data.training.retrainStep,
    remaining: data.training.examplesUntilRetrain,
    progress: pct(
      data.training.newDataSinceLastTrain,
      data.training.retrainStep,
    ),
    bar: "bg-cyan-500",
    badge: "border-border bg-muted text-muted-foreground",
  };
}

function SectionHeader({
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

function CorpusBlock({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  detail: string;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-2xl font-semibold tabular-nums",
          tone === "good" && "text-emerald-700 dark:text-emerald-300",
          tone === "bad" && "text-rose-700 dark:text-rose-300",
        )}
      >
        {formatInt(value)}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
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

function StatusBadge({ status }: { status: RungStatus }) {
  const tone = statusTone(status);
  return (
    <Badge
      variant="outline"
      className={cn("h-5 rounded-md px-1.5 text-xs", tone.badge)}
    >
      {STATUS_COPY[status]}
    </Badge>
  );
}

function SelectControl({
  value,
  onValueChange,
  options,
  width,
  hint,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: [string, string][];
  width: string;
  hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <Select value={value} onValueChange={onValueChange}>
            <SelectTrigger size="sm" className={cn("h-8 text-xs", width)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map(([optionValue, label]) => (
                <SelectItem key={optionValue} value={optionValue}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-sm">{hint}</TooltipContent>
    </Tooltip>
  );
}

function summarizeState(data: PipelineData, rungs: EvaluatedRung[]) {
  if (data.training.modelsInTraining > 0) {
    return {
      label: "Training",
      description: "A model run is active. Watch heartbeat and stage progress.",
      icon: Clock3,
      badge:
        "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    };
  }
  if (rungs.some((rung) => rung.verdict.status === "fail")) {
    return {
      label: "Blocked",
      description: "At least one gate is failing and needs operator attention.",
      icon: AlertTriangle,
      badge:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }
  if (
    rungs.some(
      (rung) =>
        rung.verdict.status === "warn" || rung.verdict.status === "pending",
    )
  ) {
    return {
      label: "Watch",
      description:
        "The pipeline is running, but one or more gates are not green.",
      icon: CircleDashed,
      badge:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  return {
    label: "Clear",
    description:
      "All current gates are passing. Monitor live predictions and ROI.",
    icon: CheckCircle2,
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  };
}

function statusTone(status: RungStatus) {
  if (status === "pass") {
    return {
      icon: CheckCircle2,
      badge:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      bar: "bg-emerald-500",
      iconBox:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    };
  }
  if (status === "warn" || status === "pending") {
    return {
      icon: AlertTriangle,
      badge:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      bar: "bg-amber-500",
      iconBox:
        "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }
  if (status === "fail") {
    return {
      icon: XCircle,
      badge:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      bar: "bg-rose-500",
      iconBox:
        "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    };
  }
  return {
    icon: CircleDashed,
    badge: "border-border bg-muted text-muted-foreground",
    bar: "bg-muted-foreground/40",
    iconBox: "border-border bg-muted text-muted-foreground",
  };
}

function findFocusRung(rungs: EvaluatedRung[]) {
  return (
    rungs.find((rung) => rung.verdict.status === "fail") ??
    rungs.find((rung) => rung.verdict.status === "warn") ??
    rungs.find((rung) => rung.verdict.status === "pending") ??
    rungs.find((rung) => rung.verdict.status === "blocked")
  );
}

function countStatus(rungs: EvaluatedRung[], status: RungStatus) {
  return rungs.filter((rung) => rung.verdict.status === status).length;
}

function ProviderOdds({ provider, odds }: { provider: string; odds: number }) {
  return (
    <>
      <span className={cn("text-[10px] mr-1", getProviderTextInline(provider))}>
        {getProviderShortName(provider)}
      </span>
      <span className="font-medium">{odds.toFixed(2)}</span>
    </>
  );
}

function formatStake(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}

function formatMultiplier(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(2)}x`;
}

function decisionTone(decision: string) {
  if (decision === "boost") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (decision === "skip") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  if (decision === "shrink") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function outcomeTone(outcome: string) {
  if (outcome === "won" || outcome === "half_won") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (outcome === "lost" || outcome === "half_lost") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  if (outcome === "void") {
    return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
  }
  return "border-border bg-muted text-muted-foreground";
}

function modelTone(status: string | null) {
  if (status === "deployed" || status === "validated") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "training") {
    return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
  }
  if (status === "failed" || status === "rejected") {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  return "border-border bg-muted text-muted-foreground";
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

function winRateTone(value: number | null | undefined): ValueTone {
  if (value == null || !Number.isFinite(value)) return "neutral";
  if (value > 50) return "good";
  if (value < 50) return "bad";
  return "neutral";
}

function yesNoTone(value: string): ValueTone {
  if (value === "Yes") return "good";
  if (value === "No") return "bad";
  return "neutral";
}

function numericValue(value: string): number | null {
  const parsed = Number(value.replace(/[%x,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function semanticHealthTone(key: string, value: unknown): ValueTone {
  if (typeof value === "boolean") return value ? "good" : "bad";
  if (typeof value !== "number" || !Number.isFinite(value)) return "neutral";
  if (
    key.toLowerCase().startsWith("bad") ||
    key === "badLabeledNonPositiveEv"
  ) {
    return value === 0 ? "good" : "bad";
  }
  return "neutral";
}

function rungInputTone(label: string, value: string): ValueTone {
  if (value === "Yes" || value === "No") return yesNoTone(value);

  const lower = label.toLowerCase();
  const numeric = numericValue(value);
  if (numeric == null) return "neutral";

  if (
    lower.includes("roi") ||
    lower.includes("pnl") ||
    lower.includes("clv") ||
    lower.includes("delta") ||
    lower.includes("minus") ||
    lower.includes("edge")
  ) {
    return signedTone(numeric);
  }

  if (lower.includes("winrate") || lower.includes("win_rate")) {
    return winRateTone(numeric);
  }

  if (lower.startsWith("bad")) {
    return numeric === 0 ? "good" : "bad";
  }

  if (lower.includes("permissionlevel")) {
    return value === "Observe only" ? "warn" : "good";
  }

  return "neutral";
}

function describeMutationResult(payload: Record<string, unknown>): string {
  if (typeof payload.written === "number") {
    return `${payload.written} training examples written.`;
  }
  if (typeof payload.modelId === "string") {
    return "Training started.";
  }
  if (typeof payload.targetVersion === "number") {
    const prev = payload.previousVersion as number | null | undefined;
    return prev
      ? `v${prev} retired, v${payload.targetVersion} deployed.`
      : `v${payload.targetVersion} deployed.`;
  }
  return "OK.";
}

function gateCode(number: number) {
  return `G${String(number).padStart(2, "0")}`;
}

function pct(value: number, target: number) {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) {
    return 0;
  }
  return (value / target) * 100;
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

function formatDurationMs(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  const ms = Math.max(0, value);
  if (ms < 1_000) return "0s";
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatAge(value: number) {
  if (!Number.isFinite(value) || value < 0) return "-";
  return `${formatDurationMs(value)} ago`;
}

function normalizeTrainingStage(stage: string | null) {
  const normalized = String(stage ?? "loading").toLowerCase();
  if (TRAINING_STAGES.some((item) => item.id === normalized)) {
    return normalized;
  }
  if (normalized === "failed" || normalized === "rejected") return "gate";
  return "loading";
}

function schedulerLastTickTone(
  lastTickAt: number | null,
  generatedAtMs: number,
): ValueTone {
  if (lastTickAt == null) return "warn";
  const age = generatedAtMs - lastTickAt;
  if (!Number.isFinite(age)) return "warn";
  return age > 5 * 60_000 ? "bad" : "good";
}

function formatTrainingRunLabel(
  active: NonNullable<PipelineData["training"]["activeTraining"]>,
) {
  if (active.version > 0) return `Candidate v${active.version}`;
  return cleanText(active.modelId);
}

function cleanText(value: unknown) {
  return String(value ?? "-").replace(/[\u2014\u2013]/g, "-");
}
