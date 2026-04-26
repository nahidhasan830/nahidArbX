"use client";

/**
 * Strategies tab — saved filter+sizing recommendations rendered as a card grid.
 *
 * Each card surfaces the metrics most operators look at first (expected ROI
 * at promotion, live ROI, status, expected range) above the constraint chips
 * (EV / odds / kelly / markets / providers). The active toggle lives in the
 * card footer because it's the action you take *after* reading the card.
 *
 * The "Active" toggle writes directly to `betting_settings.active_strategy_ids`,
 * which is the single source of truth for which strategies the auto-placer
 * uses as a placement gate. The Settings popover edits the same field — both
 * surfaces stay in sync automatically via React Query.
 *
 * Status enum (candidate/live/paused) was removed when the value-detector
 * stopped consulting strategies in real time. The only lifecycle now is
 * available vs retired, surfaced as an "Archived" pill on retired cards.
 */

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clock,
  Hourglass,
  ListFilter,
  RotateCcw,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  OptimizationStrategyRow,
  StrategyFilters,
  StrategySizing,
} from "@/lib/optimizer/strategies";
import { formatMarketType } from "@/lib/formatting/labels";
import { getProviderShortName } from "@/lib/providers/registry";
import { cn } from "@/lib/utils";

const REFRESH_MS = 10_000;

async function fetchStrategies(): Promise<{
  strategies: OptimizationStrategyRow[];
}> {
  const res = await fetch("/api/optimizer/strategies", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface SettingsResponse {
  settings: { activeStrategyIds: string[] } & Record<string, unknown>;
}

async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const fmtPct = (n: number, digits = 1): string => `${n.toFixed(digits)}%`;

const fmtNum = (n: number): string =>
  Number.isFinite(n) ? n.toFixed(3).replace(/\.?0+$/, "") : "—";

export function StrategiesTable() {
  const qc = useQueryClient();
  const [showRetired, setShowRetired] = React.useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["optimizer", "strategies"],
    queryFn: fetchStrategies,
    refetchInterval: REFRESH_MS,
  });
  const { data: settingsData } = useQuery({
    queryKey: ["betting-settings"],
    queryFn: fetchSettings,
    staleTime: 30_000,
  });
  const activeIds = React.useMemo(
    () => new Set(settingsData?.settings.activeStrategyIds ?? []),
    [settingsData],
  );

  const setActive = useMutation({
    mutationFn: async ({
      id,
      active,
    }: {
      id: string;
      active: boolean;
    }): Promise<SettingsResponse> => {
      const current = settingsData?.settings.activeStrategyIds ?? [];
      const next = active
        ? [...new Set([...current, id])]
        : current.filter((x) => x !== id);
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeStrategyIds: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: ["betting-settings"] });
      const prev = qc.getQueryData<SettingsResponse>(["betting-settings"]);
      if (prev) {
        const cur = prev.settings.activeStrategyIds ?? [];
        const next = active
          ? [...new Set([...cur, id])]
          : cur.filter((x) => x !== id);
        qc.setQueryData<SettingsResponse>(["betting-settings"], {
          ...prev,
          settings: { ...prev.settings, activeStrategyIds: next },
        });
      }
      return { prev };
    },
    onError: (e: Error, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(["betting-settings"], ctx.prev);
      toast.error(`Couldn't change active state: ${e.message}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["betting-settings"] });
    },
  });

  const retire = useMutation({
    mutationFn: async ({ id, retire }: { id: string; retire: boolean }) => {
      const res = await fetch(`/api/optimizer/strategies/${id}/retire`, {
        method: retire ? "POST" : "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["optimizer", "strategies"] });
      qc.invalidateQueries({ queryKey: ["betting-settings"] });
      toast.success(vars.retire ? "Strategy archived" : "Strategy restored");
    },
    onError: (e: Error) => toast.error(`Failed: ${e.message}`),
  });

  if (isLoading) {
    return (
      <p className="text-sm text-muted-foreground py-4">Loading strategies…</p>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-500 py-4">
        {error instanceof Error ? error.message : "Failed to load"}
      </p>
    );
  }
  const allStrategies = data?.strategies ?? [];
  const visibleStrategies = showRetired
    ? allStrategies
    : allStrategies.filter((s) => s.retiredAt == null);
  const retiredCount = allStrategies.filter((s) => s.retiredAt != null).length;
  const activeCount = allStrategies.filter(
    (s) => s.retiredAt == null && activeIds.has(s.id),
  ).length;

  if (allStrategies.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-base text-foreground">No strategies yet</p>
        <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
          Open any completed run, click into a trial you like, and use{" "}
          <strong>Promote to strategy</strong>. Promoted strategies show up here
          — toggle <strong>Active</strong> to make the auto-placer use them as a
          placement gate.
        </p>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            <span className="text-foreground font-medium">{activeCount}</span>{" "}
            active ·{" "}
            <span className="text-foreground">{visibleStrategies.length}</span>{" "}
            shown · {allStrategies.length} total
          </span>
          {retiredCount > 0 && (
            <button
              type="button"
              onClick={() => setShowRetired((v) => !v)}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {showRetired ? "Hide" : "Show"} {retiredCount} archived
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
          {visibleStrategies.map((s) => (
            <StrategyCard
              key={s.id}
              strategy={s}
              isActive={s.retiredAt == null && activeIds.has(s.id)}
              isRetired={s.retiredAt != null}
              onSetActive={(active) => setActive.mutate({ id: s.id, active })}
              setActivePending={setActive.isPending}
              onArchive={() => {
                if (
                  confirm(
                    `Archive "${s.name}"? It can be restored from the "Show archived" view.`,
                  )
                )
                  retire.mutate({ id: s.id, retire: true });
              }}
              onRestore={() => retire.mutate({ id: s.id, retire: false })}
              retirePending={retire.isPending}
            />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Strategy card ────────────────────────────────────────────────────────────

const MIN_BETS_FOR_DRIFT = 50;

interface StatusInfo {
  label: string;
  tone: "muted" | "ok" | "warn";
  icon: typeof Clock;
}

function statusOf(liveN: number | null, outsideOosCi: boolean): StatusInfo {
  if (liveN == null || liveN === 0)
    return { label: "Awaiting bets", tone: "muted", icon: Clock };
  if (liveN < MIN_BETS_FOR_DRIFT)
    return {
      label: `Gathering · ${liveN}/${MIN_BETS_FOR_DRIFT}`,
      tone: "muted",
      icon: Hourglass,
    };
  if (outsideOosCi)
    return { label: "Drift detected", tone: "warn", icon: AlertCircle };
  return { label: "On track", tone: "ok", icon: CheckCircle2 };
}

const STATUS_TONE_CLS: Record<StatusInfo["tone"], string> = {
  muted: "bg-muted/60 text-muted-foreground border-border/60",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

interface StrategyCardProps {
  strategy: OptimizationStrategyRow;
  isActive: boolean;
  isRetired: boolean;
  onSetActive: (active: boolean) => void;
  setActivePending: boolean;
  onArchive: () => void;
  onRestore: () => void;
  retirePending: boolean;
}

function StrategyCard({
  strategy: s,
  isActive,
  isRetired,
  onSetActive,
  setActivePending,
  onArchive,
  onRestore,
  retirePending,
}: StrategyCardProps) {
  const snap = (s.metricsSnapshot as Record<string, unknown>) ?? {};
  const live = (s.liveMetrics as Record<string, unknown> | null) ?? {};
  const oosRoi = numOrNull(snap["oosRoiMean"]);
  const ciLow = numOrNull(snap["oosRoiCiLow"]);
  const ciHigh = numOrNull(snap["oosRoiCiHigh"]);
  const liveRoi = numOrNull(live["liveRoiPct"]);
  const liveN = numOrNull(live["nSettled"]);
  const drift = live["outsideOosCi"] === true;

  const status = statusOf(liveN, drift);
  const StatusIcon = status.icon;
  const driftActive = drift && liveN != null && liveN >= MIN_BETS_FOR_DRIFT;

  const hasCi = ciLow != null && ciHigh != null;
  let lo = 0;
  let hi = 1;
  if (hasCi) {
    const span = Math.max((ciHigh as number) - (ciLow as number), 0.0001);
    const pad = span * 0.2;
    lo = (ciLow as number) - pad;
    hi = (ciHigh as number) + pad;
    if (oosRoi != null) {
      lo = Math.min(lo, oosRoi - pad * 0.25);
      hi = Math.max(hi, oosRoi + pad * 0.25);
    }
    if (liveRoi != null) {
      lo = Math.min(lo, liveRoi - pad * 0.5);
      hi = Math.max(hi, liveRoi + pad * 0.5);
    }
  }
  const project = (v: number): number => {
    if (hi <= lo) return 50;
    return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  };

  return (
    <div
      className={cn(
        "relative rounded-lg border bg-card transition-colors overflow-hidden",
        isActive
          ? "border-cyan-500/40 bg-cyan-500/[0.025] shadow-[inset_3px_0_0_oklch(0.7_0.12_210/0.6)]"
          : "border-border/60",
        isRetired && "opacity-60",
      )}
    >
      <div className="p-4 space-y-3">
        {/* Header — name, badges, meta + actions */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-base text-foreground truncate">
                {s.name}
              </h3>
              {isActive && (
                <span className="inline-flex items-center px-1.5 py-0 text-[10px] uppercase tracking-wide font-medium rounded-sm bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30">
                  Active
                </span>
              )}
              {isRetired && (
                <span className="inline-flex items-center px-1.5 py-0 text-[10px] uppercase tracking-wide font-medium rounded-sm bg-muted text-muted-foreground border border-border">
                  Archived
                </span>
              )}
            </div>
            {s.description && (
              <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">
                {s.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline whitespace-nowrap pr-1">
              {formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-muted-foreground hover:text-cyan-700 dark:hover:text-cyan-300"
                >
                  <Link
                    href={`/bets?strategy=${encodeURIComponent(s.id)}`}
                    aria-label="View bets matching this strategy"
                  >
                    <ListFilter className="size-3.5" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open as filter on /bets</TooltipContent>
            </Tooltip>
            {isRetired ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground hover:text-foreground"
                    onClick={onRestore}
                    disabled={retirePending}
                    aria-label="Restore strategy"
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Restore</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-muted-foreground hover:text-red-500"
                    onClick={onArchive}
                    disabled={retirePending}
                    aria-label="Archive strategy"
                  >
                    <Archive className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Archive</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Metrics — expected vs live ROI side-by-side */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1">
          <div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-help w-fit">
                  Expected ROI
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Out-of-sample mean ROI captured when this strategy was promoted
                from a trial. The cyan band on the chart is the believable range
                around it.
              </TooltipContent>
            </Tooltip>
            <div className="text-2xl font-semibold tabular-nums leading-tight">
              {oosRoi != null ? fmtPct(oosRoi) : "—"}
            </div>
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {hasCi
                ? `${fmtPct(ciLow as number)} – ${fmtPct(ciHigh as number)}`
                : "No expected range"}
            </div>
          </div>
          <div>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground cursor-help w-fit">
                  Live ROI
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Realised ROI on bets matching this strategy&apos;s filters.
                Drift is flagged once {MIN_BETS_FOR_DRIFT}+ bets have settled
                and the live value falls outside the expected range.
              </TooltipContent>
            </Tooltip>
            <div
              className={cn(
                "text-2xl font-semibold tabular-nums leading-tight",
                liveRoi == null && "text-muted-foreground/40",
                driftActive && "text-amber-700 dark:text-amber-400",
              )}
            >
              {liveRoi != null ? fmtPct(liveRoi) : "—"}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
              <span>{liveN ?? 0} settled</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 px-1.5 py-0 rounded-sm border font-medium",
                  STATUS_TONE_CLS[status.tone],
                )}
              >
                <StatusIcon className="size-3" />
                {status.label}
              </span>
            </div>
          </div>
        </div>

        {/* Range bar */}
        {hasCi ? (
          <div className="relative h-1.5 rounded-full bg-foreground/10">
            <div
              className="absolute inset-y-0 rounded-full bg-cyan-500/40"
              style={{
                left: `${project(ciLow as number)}%`,
                right: `${100 - project(ciHigh as number)}%`,
              }}
            />
            {oosRoi != null && (
              <div
                className="absolute inset-y-[-1px] w-px bg-cyan-700/70 dark:bg-cyan-400/70"
                style={{ left: `${project(oosRoi)}%` }}
                title={`Expected mean ${fmtPct(oosRoi)}`}
              />
            )}
            {liveRoi != null && (
              <div
                className={cn(
                  "absolute -top-[3px] size-2.5 rounded-full border-2 border-background",
                  driftActive ? "bg-amber-500" : "bg-emerald-500",
                )}
                style={{
                  left: `${project(liveRoi)}%`,
                  transform: "translateX(-50%)",
                }}
                title={`Live ${fmtPct(liveRoi)}`}
              />
            )}
          </div>
        ) : (
          <div className="h-1.5 rounded-full bg-foreground/10" aria-hidden />
        )}

        {/* Filter constraints */}
        <FilterConstraints
          filters={s.filters as StrategyFilters}
          sizing={s.sizing as StrategySizing}
        />

        {/* Footer — active toggle */}
        {!isRetired && (
          <div className="flex items-center justify-between border-t border-border/40 pt-2.5">
            <label className="flex items-center gap-2 cursor-pointer">
              <Switch
                checked={isActive}
                onCheckedChange={onSetActive}
                disabled={setActivePending}
                aria-label={
                  isActive ? "Deactivate strategy" : "Activate strategy"
                }
              />
              <span className="text-xs text-foreground/90">
                Active in auto-placer
              </span>
            </label>
            {driftActive && (
              <span className="text-[11px] text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
                <AlertCircle className="size-3" />
                Live ROI outside expected range
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Filter constraints (inline filters/sizing summary) ──────────────────────

interface Pill {
  label: string;
  value: string;
}

function buildScalarPills(
  filters: StrategyFilters | null | undefined,
  sizing: StrategySizing | null | undefined,
): Pill[] {
  const out: Pill[] = [];
  if (filters?.min_ev_pct != null)
    out.push({ label: "EV ≥", value: `${fmtNum(filters.min_ev_pct)}%` });
  if (filters?.odds_lo != null || filters?.odds_hi != null) {
    const lo = filters?.odds_lo != null ? fmtNum(filters.odds_lo) : "−∞";
    const hi = filters?.odds_hi != null ? fmtNum(filters.odds_hi) : "∞";
    out.push({ label: "Odds", value: `${lo}–${hi}` });
  }
  if (filters?.min_sharp_prob != null)
    out.push({ label: "Sharp ≥", value: fmtNum(filters.min_sharp_prob) });
  if (filters?.min_tick_count != null)
    out.push({ label: "Ticks ≥", value: String(filters.min_tick_count) });
  if (filters?.max_odds_age_sec != null)
    out.push({ label: "Age ≤", value: `${filters.max_odds_age_sec}s` });
  if (filters?.pre_match_only != null)
    out.push({
      label: "Pre-match",
      value: filters.pre_match_only ? "Yes" : "No",
    });
  if (sizing?.kelly_cap_pct != null)
    out.push({ label: "Kelly cap", value: `${fmtNum(sizing.kelly_cap_pct)}%` });
  if (sizing?.kelly_fraction != null)
    out.push({
      label: "Kelly frac",
      value: `${fmtNum(sizing.kelly_fraction)}×`,
    });
  if (sizing?.staking_scheme)
    out.push({ label: "Staking", value: sizing.staking_scheme });
  return out;
}

function FilterConstraints({
  filters,
  sizing,
}: {
  filters: StrategyFilters | null | undefined;
  sizing: StrategySizing | null | undefined;
}) {
  const pills = buildScalarPills(filters, sizing);
  const markets = filters?.market_types ?? [];
  const providers = filters?.soft_providers ?? [];

  if (pills.length === 0 && markets.length === 0 && providers.length === 0)
    return null;

  return (
    <div className="space-y-1.5 rounded-md bg-muted/30 px-2.5 py-2 border border-border/40">
      {pills.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums">
          {pills.map((p) => (
            <span key={p.label} className="inline-flex items-baseline gap-1">
              <span className="text-muted-foreground">{p.label}</span>
              <span className="font-medium text-foreground/90">{p.value}</span>
            </span>
          ))}
        </div>
      )}
      {(markets.length > 0 || providers.length > 0) && (
        <div className="flex flex-col gap-0.5 text-[11px]">
          {markets.length > 0 && (
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground shrink-0 w-[60px]">
                Markets
              </span>
              <span className="text-foreground/90 truncate">
                {markets.map(formatMarketType).join(", ")}
              </span>
            </div>
          )}
          {providers.length > 0 && (
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground shrink-0 w-[60px]">
                Providers
              </span>
              <span className="text-foreground/90 truncate">
                {providers.map((p) => getProviderShortName(p)).join(", ")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
