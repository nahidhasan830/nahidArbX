"use client";

/**
 * TrainingDataTable — DataTable showing bets eligible for model training.
 *
 * Features:
 * - 4 tabs: All, since training, training set, and new rows
 * - Compact dark styling consistent with MLPipelineDashboard
 * - Plain labels with technical detail kept in tooltips
 * - Clear summary strip with human-readable labels
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CheckCircle2,
  Clock,
  Database,
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Info,
  FlaskConical,
} from "lucide-react";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";

// ── Types ─────────────────────────────────────────────────────────────

export interface TrainingRow {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  marketType: string;
  atomLabel: string;
  outcome: string;
  pnl: number | null;
  clvPct: number | null;
  mlScore: number | null;
  featureVersion: number | null;
  featureCount: number | null;
  firstSeenAt: string;
  settledAt: string | null;
  coveredByCorpus: boolean;
  exampleType: string | null;
}

interface TrainingDataResponse {
  rows: TrainingRow[];
  summary: {
    total: number;
    corpusCovered: number;
    uncoveredQualifiedBets: number;
    canonicalExamples: number;
    trainerExpectedSamples: number;
    latestModelVersion: number | null;
    latestModelStatus: string | null;
    latestModelTrainingSamples: number | null;
    deployedModelVersion: number | null;
    deployedModelTrainingSamples: number | null;
    newSinceLatestModel: number;
    newSinceDeployedModel: number;
    featureVersion: number;
    featureCount: number;
    lastTrainedAt: string | null;
  };
}

type TabFilter = "all" | "since_training" | "corpus" | "new";

// ── Query ─────────────────────────────────────────────────────────────

function useTrainingData() {
  return useQuery<TrainingDataResponse>({
    queryKey: ["ml", "training-data"],
    queryFn: async () => {
      const res = await fetch("/api/ml/training-data", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: 60000,
    retry: 1,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

const OUTCOME_STYLES: Record<string, { color: string; label: string }> = {
  won: { color: "text-emerald-400", label: "Won" },
  half_won: { color: "text-emerald-400/70", label: "½ Won" },
  lost: { color: "text-rose-400", label: "Lost" },
  half_lost: { color: "text-rose-400/70", label: "½ Lost" },
  void: { color: "text-white/40", label: "Void" },
};

function OutcomeCell({ outcome }: { outcome: string }) {
  const style = OUTCOME_STYLES[outcome] ?? {
    color: "text-white/40",
    label: outcome,
  };
  const Icon =
    outcome === "won" || outcome === "half_won"
      ? TrendingUp
      : outcome === "lost" || outcome === "half_lost"
        ? TrendingDown
        : Minus;
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium text-xs", style.color)}>
      <Icon className="size-3" />
      {style.label}
    </span>
  );
}

function StatusBadge({ covered, exampleType }: { covered: boolean; exampleType: string | null }) {
  if (covered) {
    const label =
      exampleType === "placed_settled"
        ? "Placed"
        : exampleType === "settled_detected"
          ? "Detected"
          : exampleType === "shadow_scored"
            ? "Scored"
            : "Corpus";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-400">
            <CheckCircle2 className="size-3" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-sm">
          Already saved in the main training set as a{" "}
          <strong>{label.toLowerCase()}</strong> example.
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-400">
          <Sparkles className="size-3" />
          New
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm">
        A settled bet that is eligible for the next model build but has not yet
        been copied into the main training set.
      </TooltipContent>
    </Tooltip>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ── Columns ───────────────────────────────────────────────────────────

const columns: ColumnDef<TrainingRow, unknown>[] = [
  {
    id: "status",
    header: "Status",
    accessorFn: (row) => (row.coveredByCorpus ? "corpus" : "new"),
    cell: ({ row }) => (
      <StatusBadge
        covered={row.original.coveredByCorpus}
        exampleType={row.original.exampleType}
      />
    ),
    meta: {
      hint: "Whether this bet is already in the main training set or is newly eligible.",
      initialSize: 100,
    },
  },
  {
    id: "event",
    header: "Event",
    accessorFn: (row) => `${row.homeTeam} vs ${row.awayTeam}`,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-1.5 min-w-0 max-w-[260px] cursor-default">
              <span className="text-sm text-white/90 font-medium truncate">
                {r.homeTeam}
              </span>
              <span className="text-white/40 shrink-0 text-xs">vs</span>
              <span className="text-sm text-white/90 font-medium truncate">
                {r.awayTeam}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <div className="text-sm">{r.homeTeam} vs {r.awayTeam}</div>
            {r.competition && (
              <div className="text-xs text-muted-foreground mt-0.5">{r.competition}</div>
            )}
          </TooltipContent>
        </Tooltip>
      );
    },
    meta: { hint: "The match this bet came from.", initialSize: 240 },
  },
  {
    id: "market",
    header: "Market",
    accessorFn: (row) => `${row.marketType} · ${row.atomLabel}`,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-sm text-white/70 truncate max-w-[160px] inline-block cursor-default">
              {formatMarketType(r.marketType)} · {formatAtomLabel(r.atomLabel)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {formatMarketType(r.marketType)} · {formatAtomLabel(r.atomLabel)}
          </TooltipContent>
        </Tooltip>
      );
    },
    meta: { hint: "The betting market and selection.", initialSize: 160 },
  },
  {
    id: "outcome",
    accessorKey: "outcome",
    header: "Result",
    cell: ({ row }) => <OutcomeCell outcome={row.original.outcome} />,
    meta: { hint: "Whether the bet won, lost, or was void.", align: "center", initialSize: 80 },
  },
  {
    id: "pnl",
    accessorKey: "pnl",
    header: "Profit",
    cell: ({ row }) => {
      const pnl = row.original.pnl;
      if (pnl == null) return <span className="text-white/25">—</span>;
      return (
        <span
          className={cn(
            "font-mono tabular-nums text-sm font-medium",
            pnl > 0 ? "text-emerald-400" : pnl < 0 ? "text-rose-400" : "text-white/40",
          )}
        >
          {pnl > 0 ? "+" : ""}
          {pnl.toFixed(0)}
        </span>
      );
    },
    meta: { align: "right", hint: "Profit or loss in BDT.", initialSize: 70 },
  },
  {
    id: "clv",
    accessorKey: "clvPct",
    header: "Closing edge",
    cell: ({ row }) => {
      const clv = row.original.clvPct;
      if (clv == null) return <span className="text-white/25">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "font-mono tabular-nums text-sm cursor-help",
                clv > 0 ? "text-emerald-400" : clv < 0 ? "text-rose-400" : "text-white/40",
              )}
            >
              {clv > 0 ? "+" : ""}
              {clv.toFixed(1)}%
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Closing edge compares the price you got with the final sharp market
            price. Positive means you beat the market close.
          </TooltipContent>
        </Tooltip>
      );
    },
    meta: { align: "right", hint: "How much better your odds were than the final sharp market price.", initialSize: 90 },
  },
  {
    id: "mlScore",
    accessorKey: "mlScore",
    header: "Model score",
    cell: ({ row }) => {
      const s = row.original.mlScore;
      if (s == null) return <span className="text-white/25">—</span>;
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "font-mono tabular-nums text-sm font-medium cursor-help",
                s >= 0.6 ? "text-emerald-400" : s >= 0.4 ? "text-amber-400" : "text-rose-400",
              )}
            >
              {s.toFixed(3)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            How similar this bet looked to past profitable bets when it was
            detected. 0.6 or higher is strong, below 0.4 is weak.
          </TooltipContent>
        </Tooltip>
      );
    },
    meta: { align: "right", hint: "How strongly the model liked this bet at detection time.", initialSize: 80 },
  },
  {
    id: "date",
    accessorKey: "firstSeenAt",
    header: "Detected",
    cell: ({ row }) => {
      const d = row.original.firstSeenAt;
      if (!d) return <span className="text-white/25">—</span>;
      return (
        <span className="text-sm text-white/50">
          {fmtDate(d)}
        </span>
      );
    },
    meta: { align: "right", hint: "When this bet was first detected.", initialSize: 80 },
  },
];

// ── Toolbar Summary ───────────────────────────────────────────────────

function SummaryStat({
  label,
  value,
  help,
  tone,
}: {
  label: string;
  value: string | number;
  help: string;
  tone?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 text-xs text-white/60 cursor-help">
          <span>{label}</span>
          <span className={cn("font-semibold tabular-nums", tone ?? "text-white/90")}>
            {value}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-sm leading-relaxed">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}

// ── Component ─────────────────────────────────────────────────────────

export function TrainingDataTable() {
  const { data, isLoading, isError, error } = useTrainingData();
  const [activeTab, setActiveTab] = useState<TabFilter>("since_training");

  const summary = data?.summary;
  const rows = data?.rows;
  const lastTrainedAt = summary?.lastTrainedAt ?? null;

  // Count bets settled after last training
  const sinceTrainingCount = useMemo(() => {
    if (!lastTrainedAt || !rows) return 0;
    const cutoff = new Date(lastTrainedAt).getTime();
    return rows.filter(
      (r) => r.settledAt && new Date(r.settledAt).getTime() > cutoff,
    ).length;
  }, [rows, lastTrainedAt]);

  // Filter rows based on active tab
  const filteredRows = useMemo(() => {
    const currentRows = rows ?? [];
    if (activeTab === "corpus")
      return currentRows.filter((r) => r.coveredByCorpus);
    if (activeTab === "new")
      return currentRows.filter((r) => !r.coveredByCorpus);
    if (activeTab === "since_training") {
      if (!lastTrainedAt) return currentRows;
      const cutoff = new Date(lastTrainedAt).getTime();
      return currentRows.filter(
        (r) => r.settledAt && new Date(r.settledAt).getTime() > cutoff,
      );
    }
    return currentRows;
  }, [rows, activeTab, lastTrainedAt]);

  const tabs: {
    key: TabFilter;
    label: string;
    count: number;
    icon: typeof Database;
    help: string;
    highlight?: boolean;
  }[] = [
    {
      key: "since_training",
      label: "New since build",
      count: sinceTrainingCount,
      icon: FlaskConical,
      help: lastTrainedAt
        ? `Bets that settled after model v${summary?.deployedModelVersion ?? "?"} was built on ${new Date(lastTrainedAt).toLocaleDateString()}. The model has not learned from them yet.`
        : "Bets settled since the last model was built. No model has been built yet.",
      highlight: sinceTrainingCount > 0,
    },
    {
      key: "all",
      label: "All",
      count: summary?.total ?? 0,
      icon: Database,
      help: "All settled bets with current learning signals: the full eligible training pool.",
    },
    {
      key: "corpus",
      label: "Training set",
      count: summary?.corpusCovered ?? 0,
      icon: CheckCircle2,
      help: "Bets already copied into the main training set with a win/loss label.",
    },
    {
      key: "new",
      label: "New rows",
      count: summary?.uncoveredQualifiedBets ?? 0,
      icon: Clock,
      help: "Settled bets not yet copied into the main training set. They can still be used by the next local trainer view.",
    },
  ];

  if (isError) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-center">
        <p className="text-xs text-rose-400">
          Failed to load training data:{" "}
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const growthPct =
    summary && summary.trainerExpectedSamples > 0 && summary.latestModelTrainingSamples
      ? Math.round(
          ((summary.trainerExpectedSamples - summary.latestModelTrainingSamples) /
            summary.latestModelTrainingSamples) *
            100,
        )
      : null;

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 border-b border-border/50">
      {/* Tabs */}
      <div className="flex items-center gap-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <Tooltip key={tab.key}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setActiveTab(tab.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all",
                    isActive
                      ? tab.highlight
                        ? "border-amber-500/40 bg-amber-500/15 text-amber-400"
                        : "border-cyan-500/40 bg-cyan-500/15 text-cyan-400"
                      : "border-white/5 bg-white/[0.02] text-white/40 hover:bg-white/[0.05] hover:text-white/60",
                  )}
                >
                  <Icon className="size-3.5" />
                  {tab.label}
                  <span
                    className={cn(
                      "ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-mono tabular-nums",
                      isActive
                        ? tab.highlight
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-cyan-500/20 text-cyan-300"
                        : tab.highlight && tab.count > 0
                          ? "bg-amber-500/15 text-amber-400"
                          : "bg-white/5 text-white/30",
                    )}
                  >
                    {tab.count.toLocaleString()}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-sm">
                {tab.help}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* Summary stats */}
      <div className="flex flex-wrap items-center gap-3">
        <SummaryStat
          label="Training pool"
          value={summary?.trainerExpectedSamples.toLocaleString() ?? "—"}
          tone="text-cyan-300"
          help="Total examples the next trainer run is expected to use. When a main training set exists, this mirrors that set so the UI matches the trainer."
        />
        <span className="text-white/15">·</span>
        {summary?.latestModelVersion != null && (
          <>
            <SummaryStat
              label="Current model"
              value={`v${summary.latestModelVersion} (${summary.latestModelTrainingSamples?.toLocaleString() ?? "?"} samples)`}
              help={`Model v${summary.latestModelVersion} was built from ${summary.latestModelTrainingSamples?.toLocaleString() ?? "?"} examples. Status: ${summary.latestModelStatus ?? "unknown"}.`}
            />
            <span className="text-white/15">·</span>
          </>
        )}
        {growthPct !== null && growthPct > 0 && (
          <>
            <SummaryStat
              label="Growth"
              value={`+${growthPct}%`}
              tone={growthPct >= 10 ? "text-amber-400" : "text-white/60"}
              help={`${sinceTrainingCount} new examples since the last build: ${growthPct}% growth. Consider retraining when growth is meaningful and outcomes look stable.`}
            />
            <span className="text-white/15">·</span>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 text-xs text-white/30 cursor-help">
              <Info className="size-3" />
              v{summary?.featureVersion ?? "?"} · {summary?.featureCount ?? "?"} signals
            </span>
          </TooltipTrigger>
          <TooltipContent>
            Data format version {summary?.featureVersion} with {summary?.featureCount} learning signals.
            Only matching bets are shown.
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <DataTable<TrainingRow>
      data={filteredRows}
      columns={columns}
      getRowId={(row) => row.id}
      enableSorting
      enableColumnResizing
      loading={isLoading}
      density="compact"
      withCard
      toolbar={toolbar}
      className="max-h-[400px]"
      persistenceKey="ml-training-data-v2"
      renderEmpty={() => (
        <div className="flex flex-col items-center gap-2 py-8">
          <Database className="size-6 text-white/15" />
          <p className="text-sm text-white/40">
            {activeTab === "corpus"
              ? "No training-set examples yet. Settled bets can still be inspected here"
              : activeTab === "new"
                ? "All settled bets are already in the training set"
                : activeTab === "since_training"
                  ? "No new bets settled since the last training run"
                  : "No qualified bets found"}
          </p>
          {activeTab === "new" && (
            <p className="text-xs text-white/25 max-w-sm text-center">
              This is a good state: the training set is caught up with settled
              bets.
            </p>
          )}
          {activeTab === "since_training" && (
            <p className="text-xs text-white/25 max-w-sm text-center">
              The model is up to date with all available data. No retraining needed right now.
            </p>
          )}
        </div>
      )}
    />
  );
}
