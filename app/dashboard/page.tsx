"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Banknote,
  CircleDot,
  Percent,
  Target,
  TrendingDown,
  TrendingUp,
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
    expiresAt: string | null;
    msUntilExpiry: number | null;
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
  const [autoLoginBusy, setAutoLoginBusy] = useState(false);
  // Prevents the 15s interval from firing a second load() while the
  // previous one is still waiting on a slow endpoint. Without this
  // we'd stack concurrent fetches on an already-stuck backend.
  const loadInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setIsRefreshing(true);
    setFetchError(null);
    // Fire all four feeds independently so one slow backend (a stuck
    // 9W session capture can take 30-60s) doesn't freeze the whole
    // dashboard while the other three endpoints have fresh data
    // ready. Each fetch gets its own timeout via AbortController;
    // when it fires, we keep the previous state for that slice
    // rather than showing skeletons forever.
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

    // Track fetch errors per slice without letting any one of them
    // poison the whole view. Accounts + stats are the critical path
    // (hydrates the KPI strip + accounts panel); overview + bets are
    // additive.
    const errors: string[] = [];

    const loadAccounts = (async () => {
      try {
        const res = await timeoutFetch("/api/accounts");
        if (!res) return; // timeout — keep previous state
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
        // Overview is the most likely to hang (bundles queryPlayerInfo,
        // turnover, unmatched, reconciliation). Give it a bit more
        // runway than the rest but still cap so it can't lock us up.
        const res = await timeoutFetch("/api/providers/9w/overview", 15_000);
        if (!res || !res.ok) return; // non-fatal
        setOverview9W((await res.json()) as Overview9W);
      } catch {
        // non-fatal; per-card error surfaces via overview.errors
      }
    })();

    await Promise.all([loadAccounts, loadStats, loadOverview]);

    if (errors.length > 0) {
      setFetchError(errors.join(" · "));
    }
    setIsRefreshing(false);
    loadInFlightRef.current = false;
  }, []);

  const handleAutoLoginToggle = useCallback(
    async (enabled: boolean) => {
      setAutoLoginBusy(true);
      try {
        const res = await fetch("/api/providers/9w/auto-login", {
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
        setAutoLoginBusy(false);
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
        // Pull fresh account data so the new expiry + balance show up.
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

  // Auto-relogin trigger. When an account comes back with an auth-
  // style error ("not authorized", "1001", "session expired", etc.)
  // we kick off a Re-login in the background so the operator doesn't
  // have to click the button.
  //
  // Guards:
  //   • Auto-login toggle must be ON. If the operator explicitly
  //     flipped it off they're using the book elsewhere (phone, etc.)
  //     and our login would kick them off — defeats the whole point
  //     of the toggle.
  //   • Rate-limited to once-per-provider-per-minute so we never
  //     cascade into a login storm. 9W's single-session rule means
  //     hammering login actively fights the operator's other device.
  const autoReloginAttemptsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!accounts) return;
    if (!overview9W?.autoLogin?.enabled) return;
    const now = Date.now();
    for (const acc of accounts) {
      if (!acc.error) continue;
      if (reloginInProgress.has(acc.provider)) continue;
      if (!looksLikeAuthError(acc.error)) continue;
      const last = autoReloginAttemptsRef.current.get(acc.provider) ?? 0;
      if (now - last < 60_000) continue;
      autoReloginAttemptsRef.current.set(acc.provider, now);
      void handleRelogin(acc.provider);
    }
  }, [
    accounts,
    overview9W?.autoLogin?.enabled,
    reloginInProgress,
    handleRelogin,
  ]);

  const handleToggleAutoPlace = useCallback(
    async (provider: string, enabled: boolean) => {
      // Optimistically flip the local state so the toggle feels responsive;
      // roll back if the API call fails.
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
          <Badge variant="secondary" className="ml-2 text-[10px] data-text">
            {totals.betCount} bets tracked
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
    >
      <main className="space-y-8">
        {fetchError && (
          <div className="glass-panel border-destructive/40 animate-fade-up">
            <div className="py-3 px-4 flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-4" />
              Failed to load: {fetchError}
            </div>
          </div>
        )}

        {/* KPI strip — elevated metric pods with state-aware accents.
            Each pod gets a coloured left border + subtle inner glow
            based on its data (green = profit, red = loss, amber = open). */}
        <section className="animate-fade-up" style={{ animationDelay: "0ms" }}>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <MetricPod
              icon={
                (totals?.totalProfit ?? 0) >= 0 ? (
                  <TrendingUp className="size-3.5" />
                ) : (
                  <TrendingDown className="size-3.5" />
                )
              }
              label="Total P&L"
              value={signedMoney(totals?.totalProfit, currency)}
              sub={
                totals
                  ? `ROI ${signedPct(totals.roiPct)} · exp ${signedMoney(
                      totals.expectedProfit,
                      currency,
                    )}`
                  : undefined
              }
              tone={podTone(totals?.totalProfit)}
              loading={!totals}
            />
            <MetricPod
              icon={<Target className="size-3.5" />}
              label="Avg CLV"
              value={
                totals?.avgClvPct !== null && totals?.avgClvPct !== undefined
                  ? signedPct(totals.avgClvPct)
                  : "—"
              }
              sub={
                totals?.pctBeatClv !== null && totals?.pctBeatClv !== undefined
                  ? `${totals.pctBeatClv.toFixed(0)}% beat close`
                  : undefined
              }
              tone={podTone(totals?.avgClvPct ?? 0)}
              loading={!totals}
            />
            <MetricPod
              icon={<Percent className="size-3.5" />}
              label="Win Rate"
              value={totals ? `${totals.winRatePct.toFixed(1)}%` : "—"}
              sub={
                totals && stats
                  ? `${totals.settledCount} settled · ${
                      stats.streaks.currentType === "none"
                        ? "no streak"
                        : `${stats.streaks.currentLen}${stats.streaks.currentType} streak`
                    }`
                  : undefined
              }
              tone="brand"
              loading={!totals}
            />
            <MetricPod
              icon={<CircleDot className="size-3.5" />}
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
            <MetricPod
              icon={<Banknote className="size-3.5" />}
              label="Max DD"
              value={totals ? money(totals.maxDrawdown, currency) : "—"}
              sub={
                stats
                  ? `Kelly δ ${signedPct(stats.kellyAdherence.avgDeviationPct)}`
                  : undefined
              }
              tone="neutral"
              loading={!totals}
            />
          </div>
        </section>

        {/* Betting Accounts — full-row carousel */}
        <section className="animate-fade-up" style={{ animationDelay: "80ms" }}>
          <BettingAccountsPanel
            accounts={accounts}
            overview9W={overview9W}
            onToggleAutoPlace={handleToggleAutoPlace}
            onRelogin={handleRelogin}
            reloginInProgress={reloginInProgress}
            onToggleAutoLogin={handleAutoLoginToggle}
            autoLoginBusy={autoLoginBusy}
          />
        </section>

        {/* P&L Curve + Activity Heatmap — glass panel cards */}
        <section
          className="grid grid-cols-1 xl:grid-cols-2 gap-4 animate-fade-up"
          style={{ animationDelay: "160ms" }}
        >
          <div className="glass-panel p-0 overflow-hidden">
            <div className="px-4 pt-4 pb-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-tight">
                  P&L Curve
                </h3>
                <ChartLegend />
              </div>
            </div>
            <div className="px-4 pb-4">
              {stats ? (
                <PnlChart
                  data={stats.pnlSeries}
                  currency={currency}
                  height={200}
                />
              ) : (
                <Skeleton className="h-[200px] w-full rounded-lg" />
              )}
              {totals && (
                <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
                  <InlineStat
                    label="Turnover"
                    value={money(totals.totalStake, currency)}
                  />
                  <InlineStat
                    label="Max DD"
                    value={money(totals.maxDrawdown, currency)}
                    valueClass="text-danger"
                  />
                  <InlineStat
                    label="Avg stake"
                    value={money(totals.avgStake, currency)}
                  />
                  <InlineStat
                    label="Avg odds"
                    value={totals.avgOdds.toFixed(2)}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="glass-panel p-0 overflow-hidden flex flex-col">
            <div className="px-4 pt-4 pb-1">
              <h3 className="text-sm font-semibold tracking-tight">
                Activity Heatmap
              </h3>
            </div>
            <div className="px-4 pb-4 flex-1 flex flex-col">
              {stats ? (
                <Heatmap cells={stats.heatmap} currency={currency} />
              ) : (
                <Skeleton className="flex-1 w-full min-h-[160px] rounded-lg" />
              )}
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

// Account-row UI lives in `<BettingAccountsPanel>` — see
// `components/dashboard/BettingAccountsPanel.tsx`.

// --------------------------- Small shared components ---------------------------

type PodTone = "positive" | "negative" | "warning" | "brand" | "neutral";

/**
 * Elevated metric pod — the primary KPI display unit.
 *
 * Design language: dark semi-transparent card with a coloured left-border
 * accent + subtle inner glow, both keyed to the data state. Icons are back
 * (small, muted) to give the eye an anchor when scanning the strip.
 *
 * Numbers use the mono font (JetBrains Mono) via `data-text` class for
 * that trading-terminal feel.
 */
function MetricPod({
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
  const toneClass =
    tone === "positive"
      ? "metric-pod--positive"
      : tone === "negative"
        ? "metric-pod--negative"
        : tone === "warning"
          ? "metric-pod--warning"
          : tone === "brand"
            ? "metric-pod--brand"
            : "";

  const valueColor =
    tone === "positive"
      ? "text-emerald-400"
      : tone === "negative"
        ? "text-danger"
        : tone === "warning"
          ? "text-amber-400"
          : tone === "brand"
            ? "text-cyan-400"
            : "text-foreground";

  return (
    <div className={cn("metric-pod", toneClass)}>
      {/* Label row with icon */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {icon && <span className="text-muted-foreground/60">{icon}</span>}
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium truncate">
          {label}
        </span>
      </div>
      {/* Value */}
      {loading ? (
        <div className="space-y-1.5">
          <div className="h-5 w-24 rounded animate-shimmer" />
          <div
            className="h-3 w-32 rounded animate-shimmer"
            style={{ animationDelay: "0.15s" }}
          />
        </div>
      ) : (
        <>
          <div
            className={cn(
              "text-lg font-semibold leading-tight data-text",
              valueColor,
            )}
          >
            {value}
          </div>
          {sub && (
            <div className="mt-1 text-[10.5px] text-muted-foreground/80 truncate data-text leading-tight">
              {sub}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Tight inline `label·value` pair used under chart cards. Muted
 * labels and bright values — no card-lines, no bordered tiles.
 */
function InlineStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground/70">{label}</span>{" "}
      <span className={cn("text-foreground data-text font-medium", valueClass)}>
        {value}
      </span>
    </span>
  );
}

function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70">
      <LegendItem color="bg-cyan-400" label="Actual P&L" />
      <LegendItem color="bg-muted-foreground/60" label="Expected (EV)" dashed />
    </div>
  );
}

function LegendItem({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          "inline-block w-4 h-0.5 rounded-full",
          color,
          dashed &&
            "[background-image:repeating-linear-gradient(90deg,currentColor_0,currentColor_3px,transparent_3px,transparent_6px)] [background-color:transparent]",
        )}
      />
      {label}
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

function pnlClass(v: number | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (v > 0) return "text-emerald-400";
  if (v < 0) return "text-danger";
  return undefined;
}

/** Maps a numeric value to a metric-pod visual tone. */
function podTone(v: number | null | undefined): PodTone {
  if (v === null || v === undefined) return "neutral";
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "neutral";
}

/**
 * Heuristic: does this error string look like the book kicked us off
 * and a fresh login would fix it? We match on 9W's two failure
 * modes (status 1001 + "not authorized" envelope, and the generic
 * "session expired" variants that bubble up from SessionExpiredError).
 * Transport errors (timeouts, 5xx) deliberately fall through — no point
 * re-logging when the book isn't reachable at all.
 */
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
