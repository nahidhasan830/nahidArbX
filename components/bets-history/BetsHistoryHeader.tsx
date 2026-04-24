"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Banknote, HeartPulse } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Polls the same cadence as the table so numbers don't drift apart visually.
const REFRESH_MS = 30_000;

// Mirrors the subset of /api/accounts/stats we actually render. Keeping this
// narrow rather than importing the route's internal shape avoids coupling the
// header to every field the stats endpoint happens to expose.
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

/**
 * Compact KPI strip rendered next to the "Bets" page title. Replaces the old
 * static subtitle with live numbers sourced from /api/accounts/stats. Every
 * metric carries a plain-English tooltip — the page is visited by non-
 * technical users who shouldn't need to guess what each number means.
 */
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
          <span
            className={cn(
              "font-medium tabular-nums",
              tone === "positive" && "text-emerald-400",
              tone === "negative" && "text-rose-400",
              tone === "neutral" && "text-foreground",
              tone === "muted" && "text-muted-foreground",
              tone === "onHold" && "text-amber-400",
              loading && "opacity-60",
            )}
          >
            {value}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Settlement health indicator — pulls from /api/settlement and shows a
 * traffic light. Shares cadence with the rest of the header. Kept inline
 * rather than reusing the existing <SettlementStatusChip> from
 * SettlementMonitor.tsx so the header styling stays consistent.
 */
function SettlementChip() {
  const { data } = useQuery({
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
        };
      };
      if (!body.ok) throw new Error("settlement non-ok");
      return body.data;
    },
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  const healthy = !!data?.active && !data?.disabled && !data?.lastError;
  const stopped = !!data?.disabled || !data?.active;

  const color = healthy
    ? "text-emerald-400"
    : stopped
      ? "text-rose-400"
      : "text-amber-400";
  const label = healthy
    ? "Healthy"
    : data?.disabled
      ? "Disabled"
      : !data?.active
        ? "Stopped"
        : data?.lastError
          ? "Error"
          : "Unknown";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 text-muted-foreground cursor-help">
          <HeartPulse className={cn("size-3", color)} />
          <span className="opacity-80">Settlement</span>
          <span className={cn("font-medium", color)}>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px]">
        <span>
          <b>Settlement pipeline.</b> The background job that checks each match
          result and marks your bets won / lost / void automatically. Green =
          running; Amber = running with recent errors; Red = stopped or
          disabled.
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
