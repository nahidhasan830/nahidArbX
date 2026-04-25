"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Pause,
  Play,
  Power,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  OptimizationStrategyRow,
  StrategyFilters,
  StrategySizing,
} from "@/lib/optimizer/strategies";
import { ValidationHistory } from "./ValidationHistory";
import { formatMarketType } from "@/lib/formatting/labels";

const REFRESH_MS = 10_000;

async function fetchStrategies(): Promise<{
  strategies: OptimizationStrategyRow[];
}> {
  const res = await fetch("/api/optimizer/strategies", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const fmt = (n: unknown, digits = 2): string => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
};

const STATUS_STYLES: Record<string, string> = {
  candidate: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  live: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  paused: "bg-muted text-muted-foreground border-border",
  retired: "bg-red-500/10 text-red-500 border-red-500/30",
};

export function StrategiesTable() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["optimizer", "strategies"],
    queryFn: fetchStrategies,
    refetchInterval: REFRESH_MS,
  });

  const setStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const res = await fetch(`/api/optimizer/strategies/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["optimizer", "strategies"] }),
    onError: (e: Error) => toast.error(`Status change failed: ${e.message}`),
  });

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground py-4">Loading strategies…</p>
    );
  }
  if (isError) {
    return (
      <p className="text-xs text-red-500 py-4">
        {error instanceof Error ? error.message : "Failed to load"}
      </p>
    );
  }
  const strategies = data?.strategies ?? [];
  if (strategies.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-sm text-muted-foreground">No strategies yet</p>
        <p className="text-[11px] text-muted-foreground">
          Open any completed run, click into a trial you like, and use{" "}
          <strong>Promote to strategy</strong>. It starts as a candidate;
          activate from this tab to make it live.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr className="text-left">
            <th className="px-1 w-6"></th>
            <th className="px-3 py-2 font-medium">Name / status</th>
            <th className="px-3 py-2 font-medium text-right">
              <TooltipProvider delayDuration={200}>
                <TermTooltip term="roi">ROI at promotion</TermTooltip>
              </TooltipProvider>{" "}
              <TooltipProvider delayDuration={200}>
                <TermTooltip term="ci" iconOnly />
              </TooltipProvider>
            </th>
            <th className="px-3 py-2 font-medium text-right">Live ROI</th>
            <th className="px-3 py-2 font-medium text-right">Live n</th>
            <th className="px-3 py-2 font-medium">Drift</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => {
            const snap = (s.metricsSnapshot as Record<string, unknown>) ?? {};
            const live =
              (s.liveMetrics as Record<string, unknown> | null) ?? {};
            const oosRoi = snap["oosRoiMean"];
            const oosCiLow = snap["oosRoiCiLow"];
            const oosCiHigh = snap["oosRoiCiHigh"];
            const liveRoi = live["liveRoiPct"];
            const liveN = live["nTotal"];
            const drift = live["outsideOosCi"] === true;
            const isOpen = expanded.has(s.id);
            return (
              <React.Fragment key={s.id}>
                <tr
                  className="border-t border-border/60 hover:bg-muted/20 cursor-pointer"
                  onClick={() => toggleExpanded(s.id)}
                >
                  <td className="px-1 text-muted-foreground">
                    {isOpen ? (
                      <ChevronDown className="size-3.5" />
                    ) : (
                      <ChevronRight className="size-3.5" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium flex items-center gap-2">
                      {s.name}
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-2 py-0.5 ${STATUS_STYLES[s.status] ?? ""}`}
                      >
                        {s.status}
                      </Badge>
                    </div>
                    {s.description && (
                      <div className="text-[10px] text-muted-foreground">
                        {s.description}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {fmt(oosRoi)}%
                    <span className="text-muted-foreground ml-1 text-[10px]">
                      [{fmt(oosCiLow, 1)}, {fmt(oosCiHigh, 1)}]
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {liveRoi !== null && liveRoi !== undefined
                      ? `${fmt(liveRoi)}%`
                      : "—"}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-right">
                    {typeof liveN === "number" ? liveN : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {drift ? (
                      <span className="inline-flex items-center gap-1 text-amber-600 text-[10px]">
                        <AlertCircle className="size-3" />
                        Outside CI
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">
                        —
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatDistanceToNow(new Date(s.createdAt), {
                      addSuffix: true,
                    })}
                  </td>
                  <td
                    className="px-3 py-2 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="inline-flex gap-1">
                      {s.status === "candidate" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-emerald-600"
                          onClick={() =>
                            setStatus.mutate({ id: s.id, status: "live" })
                          }
                          disabled={setStatus.isPending}
                          title="Activate (go live)"
                        >
                          <Power className="size-3.5" />
                        </Button>
                      )}
                      {s.status === "live" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-amber-600"
                          onClick={() =>
                            setStatus.mutate({ id: s.id, status: "paused" })
                          }
                          disabled={setStatus.isPending}
                          title="Pause"
                        >
                          <Pause className="size-3.5" />
                        </Button>
                      )}
                      {s.status === "paused" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-emerald-600"
                          onClick={() =>
                            setStatus.mutate({ id: s.id, status: "live" })
                          }
                          disabled={setStatus.isPending}
                          title="Resume"
                        >
                          <Play className="size-3.5" />
                        </Button>
                      )}
                      {s.status !== "retired" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-red-500"
                          onClick={() => {
                            if (confirm(`Retire "${s.name}"? Cannot undo.`))
                              setStatus.mutate({ id: s.id, status: "retired" });
                          }}
                          disabled={setStatus.isPending}
                          title="Retire"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-border/40 bg-muted/10">
                    <td className="px-1"></td>
                    <td colSpan={6} className="px-3 py-3">
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="space-y-4"
                      >
                        <StrategyConfigPanel
                          filters={s.filters as StrategyFilters}
                          sizing={s.sizing as StrategySizing}
                        />
                        <ValidationHistory strategyId={s.id} />
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Strategy config panel ─────────────────────────────────────────────────────

const FILTER_LABELS: Record<string, string> = {
  min_ev_pct: "Min EV %",
  max_odds_age_sec: "Max odds age (s)",
  min_sharp_prob: "Min sharp prob",
  odds_lo: "Odds min",
  odds_hi: "Odds max",
  min_tick_count: "Min ticks",
  pre_match_only: "Pre-match only",
  soft_providers: "Providers",
  market_types: "Markets",
};

const SIZING_LABELS: Record<string, string> = {
  kelly_fraction: "Kelly fraction",
  kelly_cap_pct: "Kelly cap %",
  staking_scheme: "Staking scheme",
};

function fmtFilterValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (key === "market_types")
      return (value as string[]).map(formatMarketType).join(", ");
    return (value as string[]).join(", ");
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toFixed(3).replace(/\.?0+$/, "")
      : "—";
  }
  return String(value);
}

function ConfigGrid({
  title,
  entries,
}: {
  title: string;
  entries: [string, unknown][];
}) {
  const active = entries.filter(
    ([, v]) =>
      v !== null &&
      v !== undefined &&
      !(Array.isArray(v) && (v as unknown[]).length === 0),
  );
  if (active.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </p>
      <div className="rounded-md border border-border/60 bg-muted/30 divide-y divide-border/40">
        {active.map(([k, v]) => (
          <div
            key={k}
            className="flex items-center justify-between px-2.5 py-1 text-[11px]"
          >
            <span className="text-muted-foreground shrink-0">
              {FILTER_LABELS[k] ?? SIZING_LABELS[k] ?? k}
            </span>
            <span className="tabular-nums font-medium text-right ml-4 max-w-[60%] truncate">
              {fmtFilterValue(k, v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StrategyConfigPanel({
  filters,
  sizing,
}: {
  filters: StrategyFilters | null | undefined;
  sizing: StrategySizing | null | undefined;
}) {
  const filterEntries = filters
    ? (Object.entries(filters) as [string, unknown][])
    : [];
  const sizingEntries = sizing
    ? (Object.entries(sizing) as [string, unknown][])
    : [];

  if (filterEntries.length === 0 && sizingEntries.length === 0) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-1">
      <ConfigGrid title="Filters" entries={filterEntries} />
      <ConfigGrid title="Sizing" entries={sizingEntries} />
    </div>
  );
}
