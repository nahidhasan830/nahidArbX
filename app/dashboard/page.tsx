"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Banknote,
  CircleDot,
  Loader2,
  Percent,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AppShell } from "@/components/nav/AppShell";
import { PnlChart } from "@/components/dashboard/PnlChart";
import { Breakdown } from "@/components/dashboard/Breakdown";
import { EdgeDecayChart } from "@/components/dashboard/EdgeDecayChart";
import { Heatmap } from "@/components/dashboard/Heatmap";
import { BettingAccountsPanel } from "@/components/dashboard/BettingAccountsPanel";
import { BettingStrategyPopover } from "@/components/dashboard/BettingStrategyCard";

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

type BetStatus = "open" | "won" | "lost" | "void" | "half-won" | "half-lost";

interface PlacedBet {
  id: string;
  placedAt: string;
  provider: string;
  providerDisplayName: string;
  sport: string;
  league: string;
  eventName: string;
  marketName: string;
  marketFamily: string;
  selectionName: string;
  stake: number;
  kellyStake: number;
  odds: number;
  closingOdds: number | null;
  evPct: number;
  clvPct: number | null;
  status: BetStatus;
  pnl: number | null;
  currency: string;
  isDemo: boolean;
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

type StatusFilter = "all" | "open" | "settled";

// --------------------------- Constants ---------------------------

const REFRESH_MS = 15_000;

// Matches the provider palette in BacktestTable.tsx.
const PROVIDER_SHORT: Record<string, string> = {
  "ninewickets-exchange": "9W-Ex",
  "ninewickets-sportsbook": "9W-SB",
  betconstruct: "BC",
  pinnacle: "Pinnacle",
};
const PROVIDER_COLOR: Record<string, string> = {
  "ninewickets-exchange": "text-purple-400",
  "ninewickets-sportsbook": "text-amber-400",
  betconstruct: "text-sky-400",
  pinnacle: "text-cyan-400",
};
const OUTCOME_PILL: Record<BetStatus, string> = {
  open: "bg-sky-500/15 text-sky-400 border border-sky-500/30",
  won: "bg-emerald-500/15 text-emerald-500 border border-emerald-500/30",
  "half-won": "bg-emerald-500/10 text-emerald-400 border border-emerald-500/25",
  lost: "bg-danger/15 text-danger border border-danger/30",
  "half-lost": "bg-danger/10 text-danger/80 border border-danger/25",
  void: "bg-slate-500/15 text-slate-400 border border-slate-500/30",
};
const OUTCOME_LABEL: Record<BetStatus, string> = {
  open: "Open",
  won: "Won",
  "half-won": "½ Won",
  lost: "Lost",
  "half-lost": "½ Lost",
  void: "Void",
};

// --------------------------- Page ---------------------------

export default function DashboardPage() {
  const [accounts, setAccounts] = useState<BettingAccount[] | null>(null);
  const [bets, setBets] = useState<PlacedBet[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
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
        const res = await timeoutFetch("/api/betting-accounts");
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

    const loadBets = (async () => {
      try {
        const res = await timeoutFetch("/api/placed-bets");
        if (!res) return;
        if (!res.ok) throw new Error(`placed-bets HTTP ${res.status}`);
        const b = (await res.json()) as { bets: PlacedBet[] };
        setBets(b.bets);
      } catch (err) {
        errors.push(
          `bets: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();

    const loadStats = (async () => {
      try {
        const res = await timeoutFetch("/api/betting-stats");
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

    await Promise.all([loadAccounts, loadBets, loadStats, loadOverview]);

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
        const res = await fetch("/api/betting-accounts", {
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

  const filteredBets = useMemo(() => {
    if (!bets) return [];
    return bets.filter((b) => {
      if (filter === "open" && b.status !== "open") return false;
      if (filter === "settled" && b.status === "open") return false;
      if (providerFilter !== "all" && b.provider !== providerFilter)
        return false;
      return true;
    });
  }, [bets, filter, providerFilter]);

  const totals = stats?.totals;
  const currency = stats?.currency ?? "BDT";

  return (
    <AppShell
      title="Dashboard"
      titleBadge={
        totals ? (
          <Badge variant="secondary" className="ml-2 text-[10px]">
            {totals.betCount} bets tracked
          </Badge>
        ) : null
      }
      actions={
        <div className="flex items-center gap-2">
          <BettingStrategyPopover />
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={isRefreshing}
          >
            {isRefreshing ? (
              <Loader2 className="size-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5 mr-1" />
            )}
            Refresh
          </Button>
        </div>
      }
    >
      <main className="space-y-6">
        {fetchError && (
          <Card className="border-destructive/50">
            <CardContent className="py-3 flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="size-4" />
              Failed to load: {fetchError}
            </CardContent>
          </Card>
        )}

        {/* KPI bar — one unified card, hairline dividers via gap-px.
            Luck δ folded into P&L sub (actual vs expected);
            Streak folded into Win Rate sub. */}
        <section>
          <Card className="p-0 gap-0 overflow-hidden bg-border">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px">
              <KpiCell
                icon={<Wallet className="size-3.5" />}
                label="Bankroll"
                value={money(totals?.bankroll, currency)}
                sub={totals ? `${totals.betCount} bets tracked` : undefined}
                loading={!totals}
              />
              <KpiCell
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
                valueClass={pnlClass(totals?.totalProfit)}
                loading={!totals}
              />
              <KpiCell
                icon={<Target className="size-3.5" />}
                label="Avg CLV"
                value={
                  totals?.avgClvPct !== null && totals?.avgClvPct !== undefined
                    ? signedPct(totals.avgClvPct)
                    : "—"
                }
                sub={
                  totals?.pctBeatClv !== null &&
                  totals?.pctBeatClv !== undefined
                    ? `${totals.pctBeatClv.toFixed(0)}% beat close`
                    : undefined
                }
                valueClass={pnlClass(totals?.avgClvPct ?? 0)}
                loading={!totals}
              />
              <KpiCell
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
                loading={!totals}
              />
              <KpiCell
                icon={<CircleDot className="size-3.5" />}
                label="Open Bets"
                value={totals ? String(totals.openBets) : "—"}
                sub={
                  totals
                    ? `${money(totals.openStake, currency)} at stake`
                    : undefined
                }
                loading={!totals}
              />
              <KpiCell
                icon={<Banknote className="size-3.5" />}
                label="Max DD"
                value={totals ? money(totals.maxDrawdown, currency) : "—"}
                sub={
                  stats
                    ? `Kelly δ ${signedPct(stats.kellyAdherence.avgDeviationPct)}`
                    : undefined
                }
                loading={!totals}
              />
            </div>
          </Card>
        </section>

        {/* Betting Accounts — full-row carousel. Auto-betting strategy
            moved to the header Settings popover so it doesn't compete
            for primary real estate. */}
        <BettingAccountsPanel
          accounts={accounts}
          overview9W={overview9W}
          onToggleAutoPlace={handleToggleAutoPlace}
          onRelogin={handleRelogin}
          reloginInProgress={reloginInProgress}
          onToggleAutoLogin={handleAutoLoginToggle}
          autoLoginBusy={autoLoginBusy}
        />

        {/* P&L Curve + Activity Heatmap — 50/50 split so the chart
            is visible above the fold and the week-heatmap reads
            alongside it as a temporal companion rather than on its
            own row. Edge Decay drops to its own row below. */}
        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">P&L Curve</CardTitle>
                <ChartLegend />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {stats ? (
                <PnlChart
                  data={stats.pnlSeries}
                  currency={currency}
                  height={180}
                />
              ) : (
                <Skeleton className="h-[180px] w-full" />
              )}
              {totals && (
                <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-sm">Activity Heatmap</CardTitle>
            </CardHeader>
            {/* flex-1 so the CardContent stretches to the P&L card's
                height; the heatmap's h-full then fills the space. */}
            <CardContent className="flex-1 flex flex-col pt-0">
              {stats ? (
                <Heatmap cells={stats.heatmap} currency={currency} />
              ) : (
                <Skeleton className="flex-1 w-full min-h-[160px]" />
              )}
            </CardContent>
          </Card>
        </section>

        {/* Edge Decay — full-width on its own row. */}
        <section>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Edge Decay by Book
                <span className="text-[11px] text-muted-foreground font-normal">
                  Weekly avg CLV per book — flat/negative = book has sharpened
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stats ? (
                <EdgeDecayChart
                  books={stats.edgeDecay.books}
                  points={stats.edgeDecay.points}
                  height={220}
                />
              ) : (
                <Skeleton className="h-[220px] w-full" />
              )}
            </CardContent>
          </Card>
        </section>

        {/* Breakdowns + Top bets */}
        <section className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Breakdowns
                <span className="text-[11px] text-muted-foreground font-normal">
                  ROI and CLV by segment
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {stats ? (
                <Breakdown
                  currency={currency}
                  tabs={[
                    { key: "book", label: "By Book", rows: stats.byBook },
                    { key: "market", label: "By Market", rows: stats.byMarket },
                    { key: "sport", label: "By Sport", rows: stats.bySport },
                    {
                      key: "odds",
                      label: "By Odds",
                      rows: stats.byOddsBucket,
                    },
                  ]}
                />
              ) : (
                <Skeleton className="h-48 w-full" />
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-3">
            <TopBetsCard
              title="Top Wins"
              accent="emerald"
              bets={stats?.topWins}
              currency={currency}
            />
            <TopBetsCard
              title="Top Losses"
              accent="rose"
              bets={stats?.topLosses}
              currency={currency}
            />
          </div>
        </section>

        {/* Bet log — spreadsheet-styled */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Bet Log
              </h2>
              {bets !== null && (
                <span className="text-[11px] text-muted-foreground">
                  {filteredBets.length} of {bets.length}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <FilterPills
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All" },
                  { value: "open", label: "Open" },
                  { value: "settled", label: "Settled" },
                ]}
              />
              {accounts && accounts.length > 1 && (
                <ProviderFilter
                  accounts={accounts}
                  value={providerFilter}
                  onChange={setProviderFilter}
                />
              )}
            </div>
          </div>
          <Card className="p-0 overflow-hidden">
            <div className="max-h-[600px] overflow-auto">
              <BetLogTable rows={filteredBets} loading={bets === null} />
            </div>
          </Card>
          {bets?.some((b) => b.isDemo) && (
            <div className="text-[11px] text-muted-foreground mt-2 flex items-center gap-1.5">
              <Banknote className="size-3" />
              Showing demo bets — real bet tracking lands once the transactions
              feed is wired up.
            </div>
          )}
        </section>
      </main>
    </AppShell>
  );
}

// --------------------------- Bet log (spreadsheet style) ---------------------------

function BetLogTable({
  rows,
  loading,
}: {
  rows: PlacedBet[];
  loading: boolean;
}) {
  const thBase =
    "text-left px-2 font-semibold text-[11px] text-muted-foreground whitespace-nowrap h-8";
  const tdBase = "px-2 text-[11px] whitespace-nowrap align-middle";

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr className="bg-muted border-b border-border">
            <th className={cn(thBase, "w-[80px]")}>Time</th>
            <th className={cn(thBase, "w-[80px]")}>Book</th>
            <th className={thBase}>Event</th>
            <th className={thBase}>Market</th>
            <th className={thBase}>Selection</th>
            <th className={cn(thBase, "text-right w-[72px]")}>Stake</th>
            <th className={cn(thBase, "text-right w-[56px]")}>Odds</th>
            <th className={cn(thBase, "text-right w-[56px]")}>Close</th>
            <th className={cn(thBase, "text-right w-[56px]")}>EV</th>
            <th className={cn(thBase, "text-right w-[56px]")}>CLV</th>
            <th className={cn(thBase, "w-[80px]")}>Status</th>
            <th className={cn(thBase, "text-right w-[90px]")}>P&L</th>
          </tr>
        </thead>
        <tbody>
          {loading && (
            <tr>
              <td colSpan={12} className="p-4">
                <Skeleton className="h-4 w-full" />
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td
                colSpan={12}
                className="text-center text-muted-foreground py-8 text-[11px]"
              >
                No bets match the current filters.
              </td>
            </tr>
          )}
          {rows.map((bet, i) => (
            <tr
              key={bet.id}
              className={cn(
                "border-b border-border/50 h-[30px] hover:bg-muted/30",
                i % 2 === 1 && "bg-muted/10",
              )}
            >
              <td className={cn(tdBase, "text-muted-foreground")}>
                {formatRelative(bet.placedAt)}
              </td>
              <td className={tdBase}>
                <span
                  className={cn(
                    "font-medium",
                    PROVIDER_COLOR[bet.provider] ?? "text-foreground",
                  )}
                >
                  {PROVIDER_SHORT[bet.provider] ?? bet.providerDisplayName}
                </span>
              </td>
              <td className={tdBase}>
                <div className="font-medium truncate max-w-[220px]">
                  {bet.eventName}
                </div>
                <div className="text-[10px] text-muted-foreground truncate max-w-[220px]">
                  {bet.sport} · {bet.league}
                </div>
              </td>
              <td className={cn(tdBase, "text-muted-foreground")}>
                {bet.marketName}
              </td>
              <td className={tdBase}>{bet.selectionName}</td>
              <td className={cn(tdBase, "text-right tabular-nums")}>
                {moneyCompact(bet.stake, bet.currency)}
              </td>
              <td className={cn(tdBase, "text-right tabular-nums")}>
                {bet.odds.toFixed(2)}
              </td>
              <td
                className={cn(
                  tdBase,
                  "text-right tabular-nums text-muted-foreground",
                )}
              >
                {bet.closingOdds === null ? "—" : bet.closingOdds.toFixed(2)}
              </td>
              <td
                className={cn(
                  tdBase,
                  "text-right tabular-nums",
                  pnlClass(bet.evPct),
                )}
              >
                {signedPct(bet.evPct)}
              </td>
              <td
                className={cn(
                  tdBase,
                  "text-right tabular-nums",
                  pnlClass(bet.clvPct),
                )}
              >
                {bet.clvPct === null ? "—" : signedPct(bet.clvPct)}
              </td>
              <td className={tdBase}>
                <span
                  className={cn(
                    "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                    OUTCOME_PILL[bet.status],
                  )}
                >
                  {OUTCOME_LABEL[bet.status]}
                </span>
              </td>
              <td
                className={cn(
                  tdBase,
                  "text-right tabular-nums font-medium",
                  pnlClass(bet.pnl),
                )}
              >
                {bet.pnl === null ? "—" : signedMoney(bet.pnl, bet.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------- Top bets card ---------------------------

function TopBetsCard({
  title,
  accent,
  bets,
  currency,
}: {
  title: string;
  accent: "emerald" | "rose";
  bets: TopBet[] | undefined;
  currency: string;
}) {
  const accentCls = accent === "emerald" ? "text-emerald-500" : "text-danger";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {!bets && (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </>
        )}
        {bets && bets.length === 0 && (
          <div className="text-[11px] text-muted-foreground">No bets yet.</div>
        )}
        {bets?.map((b) => (
          <div
            key={b.id}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <div className="min-w-0">
              <div className="font-medium truncate">{b.eventName}</div>
              <div className="text-muted-foreground truncate flex items-center gap-1">
                <span
                  className={cn(
                    PROVIDER_COLOR[b.provider] ?? "text-foreground",
                  )}
                >
                  {PROVIDER_SHORT[b.provider] ?? b.providerDisplayName}
                </span>
                <span>·</span>
                <span>{b.selectionName}</span>
                <span>·</span>
                <span>@{b.odds.toFixed(2)}</span>
              </div>
            </div>
            <div
              className={cn("text-right tabular-nums font-semibold", accentCls)}
            >
              {signedMoney(b.pnl, currency)}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// Account-row UI lives in `<BettingAccountsPanel>` — see
// `components/dashboard/BettingAccountsPanel.tsx`.

// --------------------------- Small shared components ---------------------------

// Compact KPI cell — inspired by Stripe/Vercel/Linear metric bars.
// Two-line layout: tiny uppercase label on top, value + muted inline sub
// on one baseline-aligned line below. Dropped the icon (no information
// density per Stripe/Linear/Vercel post-2022 redesigns) and collapsed
// padding to land at ~48px total height — ~30% shorter than the old
// 3-line tile. At 6 cells that's ~160px reclaimed above the fold.
function KpiCell({
  label,
  value,
  sub,
  valueClass,
  loading,
}: {
  icon?: React.ReactNode; // accepted but unused — legacy call-site compat
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
  loading?: boolean;
}) {
  return (
    <div className="bg-card px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 min-w-0">
        {loading ? (
          <Skeleton className="h-4 w-20" />
        ) : (
          <>
            <span
              className={cn(
                "text-sm font-semibold tabular-nums leading-tight shrink-0",
                valueClass,
              )}
            >
              {value}
            </span>
            {sub && (
              <span className="text-[10.5px] text-muted-foreground truncate leading-tight">
                {sub}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-l-2 border-border pl-2">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-sm tabular-nums font-medium", valueClass)}>
        {value}
      </span>
    </div>
  );
}

/**
 * Tighter, inline variant of MiniStat used under chart cards. Renders
 * `label·value` pairs on a single baseline-aligned row with muted
 * labels and bright values — no card-lines, no bordered tiles. Saves
 * ~30px vs. the MiniStat grid.
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
      <span className="text-muted-foreground">{label}</span>{" "}
      <span
        className={cn("text-foreground tabular-nums font-medium", valueClass)}
      >
        {value}
      </span>
    </span>
  );
}

function ChartLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
      <LegendItem color="bg-emerald-500" label="Actual P&L" />
      <LegendItem color="bg-muted-foreground" label="Expected (EV)" dashed />
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

function FilterPills<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5 text-xs">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-2.5 py-1 rounded-sm transition-colors",
            value === opt.value
              ? "bg-background shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ProviderFilter({
  accounts,
  value,
  onChange,
}: {
  accounts: BettingAccount[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs bg-background border border-border rounded-md px-2 py-1"
    >
      <option value="all">All accounts</option>
      {accounts.map((a) => (
        <option key={a.provider} value={a.provider}>
          {a.providerDisplayName}
        </option>
      ))}
    </select>
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

function moneyCompact(v: number, currency: string): string {
  return `${currency} ${v.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
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
  if (v > 0) return "text-emerald-500";
  if (v < 0) return "text-danger";
  return undefined;
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

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
