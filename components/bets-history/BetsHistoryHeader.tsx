"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Banknote, HeartPulse, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const REFRESH_MS = 30_000;

type AccountsStats = {
  totals: {
    bankroll: number;
    totalProfit: number;
    openStake: number;
    openBets: number;
    settledCount: number;
  };
  currency: string;
};

const fetchAccountsStats = async (): Promise<AccountsStats> => {
  const res = await fetch("/api/accounts/stats", { credentials: "include" });
  if (!res.ok) throw new Error(`accounts/stats HTTP ${res.status}`);
  return (await res.json()) as AccountsStats;
};

const fmtMoney = (n: number | null | undefined, currency = "BDT") => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n).toLocaleString()} ${currency}`;
};

const fmtMoneyPlain = (n: number | null | undefined, currency = "BDT") => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${Math.round(n).toLocaleString()} ${currency}`;
};

export function BetsHistoryHeader() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["accounts-stats", "bets-header"] as const,
    queryFn: fetchAccountsStats,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  const currency = data?.currency ?? "BDT";
  const profit = data?.totals.totalProfit ?? null;
  const openStake = data?.totals.openStake ?? null;
  const openBets = data?.totals.openBets ?? null;

  if (isError) {
    return (
      <span className="ml-2 text-[10px] text-rose-300/80">
        Stats unavailable
      </span>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="ml-2 flex items-center gap-2 text-[11px]">
        <Metric
          icon={<Banknote className="size-3 opacity-70" />}
          label="Net P&L"
          value={fmtMoney(profit, currency)}
          tone={
            profit === null
              ? "muted"
              : profit > 0
                ? "positive"
                : profit < 0
                  ? "negative"
                  : "neutral"
          }
          loading={isLoading}
          tooltip={
            <span>
              <b>Net P&L (profit or loss).</b> Total money you&apos;ve won or
              lost across all settled bets you actually placed on a provider.
              Positive means you&apos;re up, negative means you&apos;re down.
            </span>
          }
        />
        <Dot />
        <Metric
          icon={<Activity className="size-3 opacity-70" />}
          label="Open"
          value={
            openBets === null
              ? "—"
              : `${openBets} · ${fmtMoneyPlain(openStake, currency)}`
          }
          tone="onHold"
          loading={isLoading}
          tooltip={
            <span>
              <b>Open exposure.</b> Number of bets that haven&apos;t settled
              yet, and the total stake currently tied up in them. This is the
              maximum you could still lose if every open bet lost.
            </span>
          }
        />
        <Dot />
        <SettlementChip />
      </div>
    </TooltipProvider>
  );
}

function Dot() {
  return <span className="text-muted-foreground/40">·</span>;
}

function Metric({
  icon,
  label,
  value,
  tone,
  loading,
  tooltip,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral" | "muted" | "onHold";
  loading?: boolean;
  tooltip: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-muted-foreground cursor-help">
          {icon}
          <span className="opacity-80">{label}</span>
          {loading ? (
            <Skeleton className="h-3.5 w-14 rounded" />
          ) : (
            <span
              className={cn(
                "font-medium tabular-nums",
                tone === "positive" && "text-emerald-400",
                tone === "negative" && "text-rose-400",
                tone === "neutral" && "text-foreground",
                tone === "muted" && "text-muted-foreground",
                tone === "onHold" && "text-amber-400",
              )}
            >
              {value}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function SettlementChip() {
  const { data, isLoading } = useQuery({
    queryKey: ["settlement", "header-status"] as const,
    queryFn: async () => {
      const res = await fetch("/api/settlement?runs=0&log=0", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`settlement HTTP ${res.status}`);
      const body = (await res.json()) as {
        ok: boolean;
        data: {
          active: boolean;
          paused: boolean;
          disabled: boolean;
          lastError: string | null;
          lastResult?: {
            sourceIssues?: string[];
          } | null;
        };
      };
      if (!body.ok) throw new Error("settlement non-ok");
      return body.data;
    },
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  if (isLoading && !data) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="size-3 animate-spin opacity-50" />
        <span className="opacity-80">Settlement</span>
        <Skeleton className="h-3.5 w-12 rounded" />
      </span>
    );
  }

  const healthy = !!data?.active && !data?.disabled && !data?.lastError;
  const stopped = !!data?.disabled || !data?.active;
  const sourceIssues = data?.lastResult?.sourceIssues ?? [];
  const degraded = healthy && sourceIssues.length > 0;

  const color = degraded
    ? "text-amber-400"
    : healthy
      ? "text-emerald-400"
      : stopped
        ? "text-rose-400"
        : "text-amber-400";
  const label = degraded
    ? "Degraded"
    : healthy
      ? "Healthy"
      : data?.disabled
        ? "Disabled"
        : !data?.active
          ? "Stopped"
          : data?.lastError
            ? "Error"
            : "Unknown";

  const tooltipBody = degraded ? (
    <span>
      <b>Settlement is running but data sources are degraded.</b>{" "}
      {sourceIssues.join(" ")} Bookings and corners markets may not settle until
      access is restored.
    </span>
  ) : (
    <span>
      <b>Settlement pipeline.</b> The background job that checks each match
      result and marks your bets won / lost / void automatically. Green =
      running; Amber = running with recent errors; Red = stopped or disabled.
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-muted-foreground cursor-help">
          <HeartPulse className={cn("size-3", color)} />
          <span className="opacity-80">Settlement</span>
          <span className={cn("font-medium", color)}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">{tooltipBody}</TooltipContent>
    </Tooltip>
  );
}
