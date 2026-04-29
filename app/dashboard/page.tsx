"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  TrendingUp,
  TrendingDown,
  Activity,
  Target,
  BarChart3,
  Layers,
  Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/nav/AppShell";
import { PnlChart } from "@/components/dashboard/PnlChart";
import { Heatmap } from "@/components/dashboard/Heatmap";
import { BettingAccountsPanel } from "@/components/dashboard/BettingAccountsPanel";
import { BettingStrategyPopover } from "@/components/dashboard/BettingStrategyCard";
import { ProviderConfigPopover } from "@/components/dashboard/ProviderConfigPanel";
import { RefreshButton } from "@/components/ui/refresh-button";

// --------------------------- Types ---------------------------

type SessionHealth = "healthy" | "expiring" | "expired" | "unknown";

interface Overview9W {
  ok: boolean;
  at: string;
  providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null;
  mainSite: {
    withdrawable: number | null;
    cashWallet: number | null;
    userName: string | null;
    vip: {
      nowVipName: string;
      nowVipPercent: number;
      nextVipName: string;
    } | null;
    providerStatuses: Array<{
      providerId: number;
      providerName: string;
      vendorCode: string | null;
      status: 0 | 1;
      exposure: string;
    }>;
  } | null;
  turnover: {
    canWithdraw: boolean;
    recordsCount: number;
    records: unknown[];
  } | null;
  unmatchedTickets: Array<{
    id: number;
    eventName: string;
    marketName: string;
    selectionName: string;
    odds: number;
    initPrice: number;
    lastPrice: number;
    status: number;
    createDate: number;
    createDateStr: string;
  }>;
  autoLogin: {
    enabled: boolean;
    reason: string | null;
    updatedAt: string;
  };
  reconciled: {
    pendingBefore: number;
    pendingAfter: number;
    ticketsAttached: number;
    at: string;
  } | null;
  errors: Record<string, string>;
}

interface OverviewVelki {
  ok: boolean;
  at: string;
  providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null;
  mainSite: null;
  turnover: null;
  autoLogin: {
    enabled: boolean;
    reason: string | null;
    updatedAt: string;
  };
  recaptured: boolean;
  errors: Record<string, string>;
}

interface BettingAccount {
  provider: string;
  providerDisplayName: string;
  username: string | null;
  currency: string;
  balance: number | null;
  exposure: number | null;
  minBet: number | null;
  suspended: boolean;
  lastSyncedAt: string;
  error: string | null;
  isDemo: boolean;
  autoPlaceEnabled: boolean;
  session: {
    health: SessionHealth;
    capturedAt: string | null;
  };
}

interface BreakdownRow {
  key: string;
  label: string;
  bets: number;
  stake: number;
  profit: number;
  roiPct: number;
  avgClvPct: number | null;
  openBets: number;
  openStake: number;
  settledBets: number;
}

interface PnlPoint {
  date: string;
  actual: number;
  expected: number;
}

interface TopBet {
  id: string;
  placedAt: string;
  eventName: string;
  marketName: string;
  selectionName: string;
  provider: string;
  providerDisplayName: string;
  stake: number;
  odds: number;
  pnl: number;
  roiPct: number;
}

interface Stats {
  totals: {
    bankroll: number;
    totalStake: number;
    totalProfit: number;
    roiPct: number;
    betCount: number;
    settledCount: number;
    winRatePct: number;
    avgOdds: number;
    avgStake: number;
    avgClvPct: number | null;
    pctBeatClv: number | null;
    openBets: number;
    openStake: number;
    expectedProfit: number;
    luckDelta: number;
    maxDrawdown: number;
  };
  pnlSeries: PnlPoint[];
  byBook: BreakdownRow[];
  byMarket: BreakdownRow[];
  bySport: BreakdownRow[];
  byOddsBucket: BreakdownRow[];
  edgeDecay: {
    books: { provider: string; providerDisplayName: string }[];
    points: { weekStart: string; values: Record<string, number | null> }[];
  };
  heatmap: { dow: number; hour: number; bets: number; stake: number }[];
  topWins: TopBet[];
  topLosses: TopBet[];
  streaks: {
    currentType: "W" | "L" | "none";
    currentLen: number;
    longestWin: number;
    longestLoss: number;
  };
  kellyAdherence: {
    avgDeviationPct: number;
    overstakeCount: number;
    understakeCount: number;
  };
  currency: string;
}

// --------------------------- Constants ---------------------------

const REFRESH_MS = 15_000;

// --------------------------- Page ---------------------------

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<BettingAccount[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [reloginInProgress, setReloginInProgress] = useState<Set<string>>(
    () => new Set(),
  );
  const [overview9W, setOverview9W] = useState<Overview9W | null>(null);
  const [overviewVelki, setOverviewVelki] = useState<OverviewVelki | null>(
    null,
  );
  const [autoLoginBusy, setAutoLoginBusy] = useState<Set<string>>(
    () => new Set(),
  );
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setIsRefreshing(true);
    setFetchError(null);

    const timeoutFetch = async (
      url: string,
      timeoutMs = 12_000,
    ): Promise<Response | null> => {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), timeoutMs);
      try {
        return await fetch(url, { cache: "no-store", signal: ctl.signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError")
          return null;
        throw err;
      } finally {
        window.clearTimeout(t);
      }
    };

    const errors: string[] = [];

    const loadAccounts = (async () => {
      try {
        const res = await timeoutFetch("/api/accounts");
        if (!res) return;
        if (!res.ok) throw new Error(`accounts HTTP ${res.status}`);
        const a = (await res.json()) as { accounts: BettingAccount[] };
        setAccounts(a.accounts);
      } catch (err) {
        errors.push(
          `accounts: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    const loadStats = (async () => {
      try {
        const res = await timeoutFetch("/api/accounts/stats");
        if (!res) return;
        if (!res.ok) throw new Error(`betting-stats HTTP ${res.status}`);
        const s = (await res.json()) as Stats;
        setStats(s);
      } catch (err) {
        errors.push(
          `stats: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    const loadOverview = (async () => {
      try {
        const res = await timeoutFetch("/api/providers/9w/overview", 15_000);
        if (!res || !res.ok) return;
        setOverview9W((await res.json()) as Overview9W);
      } catch {
        // non-fatal
      }
    })();

    const loadOverviewVelki = (async () => {
      try {
        const res = await timeoutFetch("/api/providers/velki/overview", 15_000);
        if (!res || !res.ok) return;
        setOverviewVelki((await res.json()) as OverviewVelki);
      } catch {
        // non-fatal
      }
    })();

    await Promise.all([
      loadAccounts,
      loadStats,
      loadOverview,
      loadOverviewVelki,
    ]);

    if (errors.length > 0) {
      setFetchError(errors.join(" · "));
    }
    setIsRefreshing(false);
    loadInFlightRef.current = false;
  }, []);

  const handleAutoLoginToggle = useCallback(
    async (provider: string, enabled: boolean) => {
      const route =
        provider === "ninewickets-sportsbook"
          ? "/api/providers/9w/auto-login"
          : provider === "velki-sportsbook"
            ? "/api/providers/velki/auto-login"
            : null;
      if (!route) return;
      setAutoLoginBusy((prev) => new Set(prev).add(provider));
      try {
        const res = await fetch(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            reason: enabled ? null : "paused via dashboard",
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await load();
      } catch (err) {
        setFetchError(
          `Auto-login toggle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setAutoLoginBusy((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }
    },
    [load],
  );

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const handleRelogin = useCallback(
    async (provider: string) => {
      setReloginInProgress((prev) => new Set(prev).add(provider));
      try {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, action: "relogin" }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        await load();
      } catch (err) {
        setFetchError(
          `Re-login failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setReloginInProgress((prev) => {
          const next = new Set(prev);
          next.delete(provider);
          return next;
        });
      }
    },
    [load],
  );

  const autoReloginAttemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!accounts) return;
    const now = Date.now();
    for (const acc of accounts) {
      if (!acc.error) continue;
      if (reloginInProgress.has(acc.provider)) continue;
      if (!looksLikeAuthError(acc.error)) continue;
      // Per-provider auto-login gate. If the operator paused auto-login
      // for THIS provider, leave the error alone — they're working on
      // it manually and a background relogin would kick them.
      if (
        acc.provider === "ninewickets-sportsbook" &&
        !overview9W?.autoLogin?.enabled
      )
        continue;
      if (
        acc.provider === "velki-sportsbook" &&
        !overviewVelki?.autoLogin?.enabled
      )
        continue;
      const last = autoReloginAttemptsRef.current.get(acc.provider) ?? 0;
      if (now - last < 60_000) continue;
      autoReloginAttemptsRef.current.set(acc.provider, now);
      void handleRelogin(acc.provider);
    }
  }, [
    accounts,
    overview9W?.autoLogin?.enabled,
    overviewVelki?.autoLogin?.enabled,
    reloginInProgress,
    handleRelogin,
  ]);

  const handleToggleAutoPlace = useCallback(
    async (provider: string, enabled: boolean) => {
      setAccounts((prev) =>
        prev
          ? prev.map((a) =>
              a.provider === provider ? { ...a, autoPlaceEnabled: enabled } : a,
            )
          : prev,
      );
      try {
        const res = await fetch("/api/auto-place", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, enabled }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        setFetchError(
          `Toggle failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        setAccounts((prev) =>
          prev
            ? prev.map((a) =>
                a.provider === provider
                  ? { ...a, autoPlaceEnabled: !enabled }
                  : a,
              )
            : prev,
        );
      }
    },
    [],
  );

  const totals = stats?.totals;
  const currency = stats?.currency ?? "BDT";

  return (
    <AppShell
      title="Dashboard"
      titleBadge={
        totals ? (
          <Badge
            variant="secondary"
            className="ml-2 text-[10px] font-mono tabular-nums tracking-tight"
          >
            {totals.betCount} bets
          </Badge>
        ) : null
      }
      actions={
        <div className="flex items-center gap-2">
          <ProviderConfigPopover />
          <BettingStrategyPopover />
          <RefreshButton
            onRefresh={load}
            isRefreshing={isRefreshing}
            label="Refresh dashboard"
          />
        </div>
      }
      edgeToEdge
    >
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto xl:overflow-hidden p-3 gap-3 bg-background">
        {/* Error banner */}
        {fetchError && (
          <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 shrink-0">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{fetchError}</span>
          </div>
        )}

        {/* ── KPI STRIP ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 shrink-0">
          <KpiCard
            icon={<TrendingUp className="size-3.5" />}
            label="Total P&L"
            value={signedMoney(totals?.totalProfit, currency)}
            sub={totals ? `ROI ${signedPct(totals.roiPct)}` : undefined}
            tone={podTone(totals?.totalProfit)}
            loading={!totals}
          />
          <KpiCard
            icon={<Activity className="size-3.5" />}
            label="Avg CLV"
            value={
              totals?.avgClvPct != null ? signedPct(totals.avgClvPct) : "—"
            }
            sub={
              totals?.pctBeatClv != null
                ? `${totals.pctBeatClv.toFixed(0)}% beat close`
                : undefined
            }
            tone={podTone(totals?.avgClvPct)}
            loading={!totals}
          />
          <KpiCard
            icon={<Target className="size-3.5" />}
            label="Win Rate"
            value={totals ? `${totals.winRatePct.toFixed(1)}%` : "—"}
            sub={totals && stats ? `${totals.settledCount} settled` : undefined}
            tone="brand"
            loading={!totals}
          />
          <KpiCard
            icon={<Layers className="size-3.5" />}
            label="Open Bets"
            value={totals ? String(totals.openBets) : "—"}
            sub={
              totals
                ? `${money(totals.openStake, currency)} at stake`
                : undefined
            }
            tone={totals && totals.openBets > 0 ? "warning" : "neutral"}
            loading={!totals}
          />
          <KpiCard
            icon={<TrendingDown className="size-3.5" />}
            label="Max Drawdown"
            value={totals ? money(totals.maxDrawdown, currency) : "—"}
            sub={
              stats
                ? `Kelly δ ${signedPct(stats.kellyAdherence.avgDeviationPct)}`
                : undefined
            }
            tone="neutral"
            loading={!totals}
          />
          <KpiCard
            icon={<BarChart3 className="size-3.5" />}
            label="Turnover"
            value={totals ? money(totals.totalStake, currency) : "—"}
            sub={
              totals
                ? `avg ${money(totals.avgStake, currency)} · ${totals.avgOdds.toFixed(2)}x`
                : undefined
            }
            tone="neutral"
            loading={!totals}
          />
        </div>

        {/* ── MAIN BODY ── */}
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(380px,540px)] gap-3 xl:flex-1 xl:min-h-0 xl:overflow-hidden">
          {/* Left column: charts stack */}
          <div className="flex flex-col gap-3 xl:min-w-0 xl:min-h-0 xl:overflow-hidden">
            {/* P&L Chart card */}
            <Panel
              title="P&L Curve"
              dot="bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.6)]"
              trailing={<ChartLegend />}
              bodyClassName="px-2 pb-2.5"
              className="h-[360px] xl:h-auto xl:flex-1 xl:min-h-0 xl:overflow-hidden"
            >
              {stats ? (
                <PnlChart
                  data={stats.pnlSeries}
                  currency={currency}
                  height="100%"
                />
              ) : (
                <Skeleton className="h-full w-full rounded-xl" />
              )}
            </Panel>

            {/* Heatmap card */}
            <Panel
              title="Activity Heatmap"
              icon={<Clock className="size-3" />}
              bodyClassName="px-4 pt-0.5 pb-3.5"
              className="shrink-0 min-h-[220px]"
            >
              {stats ? (
                <Heatmap cells={stats.heatmap} currency={currency} />
              ) : (
                <Skeleton className="h-[130px] w-full rounded-xl" />
              )}
            </Panel>
          </div>

          {/* Right column: accounts */}
          <Panel
            title="Accounts"
            dot="bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.6)]"
            trailing={
              accounts ? (
                <span className="text-[10px] font-mono tabular-nums tracking-tight text-muted-foreground/50">
                  {accounts.length}
                </span>
              ) : null
            }
            bodyClassName="p-0 xl:flex-1 xl:min-h-0 xl:overflow-y-auto"
            className="xl:overflow-hidden xl:min-h-0"
          >
            <BettingAccountsPanel
              accounts={accounts}
              stats={stats}
              overview9W={overview9W}
              overviewVelki={overviewVelki}
              onToggleAutoPlace={handleToggleAutoPlace}
              onRelogin={handleRelogin}
              reloginInProgress={reloginInProgress}
              onToggleAutoLogin={handleAutoLoginToggle}
              autoLoginBusy={autoLoginBusy}
            />
          </Panel>
        </div>
      </div>
    </AppShell>
  );
}

// --------------------------- Panel (card shell) ---------------------------

function Panel({
  title,
  icon,
  dot,
  trailing,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  /** Tailwind classes for the leading colored dot (overrides `icon`). */
  dot?: string;
  trailing?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-xl border border-border/60 bg-card/40 backdrop-blur-md shadow-[0_1px_3px_rgba(0,0,0,0.18),0_8px_24px_-8px_rgba(0,0,0,0.25)] overflow-hidden",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.09em] uppercase text-foreground/85">
          {dot ? (
            <span className={cn("size-1.5 rounded-full shrink-0", dot)} />
          ) : (
            icon
          )}
          {title}
        </div>
        {trailing}
      </header>
      <div className={cn("flex-1 min-h-0", bodyClassName)}>{children}</div>
    </section>
  );
}

// --------------------------- KPI Card ---------------------------

type PodTone = "positive" | "negative" | "warning" | "brand" | "neutral";

const TONE_VALUE: Record<PodTone, string> = {
  positive: "text-emerald-400",
  negative: "text-danger",
  warning: "text-amber-400",
  brand: "text-cyan-400",
  neutral: "text-foreground/90",
};

const TONE_RING: Record<PodTone, string> = {
  positive:
    "before:bg-emerald-500/70 bg-[radial-gradient(ellipse_at_100%_0%,oklch(0.72_0.19_168/0.06),transparent_60%)]",
  negative:
    "before:bg-danger/70 bg-[radial-gradient(ellipse_at_100%_0%,oklch(0.66_0.13_22/0.06),transparent_60%)]",
  warning:
    "before:bg-amber-400/70 bg-[radial-gradient(ellipse_at_100%_0%,oklch(0.78_0.15_80/0.06),transparent_60%)]",
  brand:
    "before:bg-cyan-400/70 bg-[radial-gradient(ellipse_at_100%_0%,oklch(0.72_0.16_190/0.08),transparent_60%)]",
  neutral: "before:bg-muted-foreground/40",
};

function KpiCard({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
  loading,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone?: PodTone;
  loading?: boolean;
}) {
  return (
    <div
      className={cn(
        // Card surface
        "relative rounded-xl border border-border/60 bg-card/40 backdrop-blur-md shadow-[0_1px_3px_rgba(0,0,0,0.18)] px-4 pt-3.5 pb-3 cursor-default overflow-hidden transition-all",
        // Left accent strip via ::before
        "before:absolute before:left-0 before:top-3 before:bottom-3 before:w-[3px] before:rounded-r-[3px]",
        // Hover lift
        "hover:border-border hover:bg-card/60 hover:-translate-y-px hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)]",
        TONE_RING[tone],
      )}
    >
      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold tracking-[0.07em] uppercase text-muted-foreground/70 mb-1.5">
        {icon && <span className="opacity-60">{icon}</span>}
        <span>{label}</span>
      </div>
      {loading ? (
        <div className="space-y-1.5 mt-1">
          <Skeleton className="h-5 w-24 rounded" />
          <Skeleton className="h-3 w-28 rounded" />
        </div>
      ) : (
        <>
          <div
            className={cn(
              "text-[15px] font-bold leading-none tracking-[-0.02em] font-mono tabular-nums",
              TONE_VALUE[tone],
            )}
          >
            {value}
          </div>
          {sub && (
            <div className="mt-1 text-[10px] text-muted-foreground/70 tracking-tight font-mono tabular-nums whitespace-nowrap overflow-hidden text-ellipsis">
              {sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --------------------------- Chart Legend ---------------------------

function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-4 h-0.5 rounded-full bg-cyan-400" />
        Actual
      </span>
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block w-4 h-0.5 rounded-full"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg,rgb(148,163,184) 0,rgb(148,163,184) 3px,transparent 3px,transparent 6px)",
          }}
        />
        Expected
      </span>
    </div>
  );
}

// --------------------------- Formatting ---------------------------

function money(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  return `${currency} ${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedMoney(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const abs = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currency} ${abs}`;
}

function signedPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function podTone(v: number | null | undefined): PodTone {
  if (v === null || v === undefined) return "neutral";
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "neutral";
}

function looksLikeAuthError(err: string | null | undefined): boolean {
  if (!err) return false;
  const s = err.toLowerCase();
  return (
    s.includes("not authorized") ||
    s.includes("1001") ||
    s.includes("session expired") ||
    s.includes("unauthorized") ||
    s.includes("session kicked") ||
    s.includes("logged off")
  );
}
