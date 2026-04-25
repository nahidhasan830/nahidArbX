"use client";

/**
 * Full-width "Betting Accounts" panel for the dashboard.
 *
 * Replaces the compact right-column card with a carousel of expanded
 * per-account cards. Each slide shows:
 *   - Header (name + session + status badges)
 *   - Balance tiles (bettable / withdrawable / exposure / min bet)
 *   - Turnover progress list (MultiProgressList — one bar per active
 *     bonus; "Ready to withdraw" empty state when records.length === 0)
 *   - Recent bets preview (1 featured row + "+N more" → modal)
 *   - Footer (username + auto-login + auto-place toggles + re-login)
 *
 * Data sources:
 *   - /api/betting-accounts                 (balances, session, demo flag)
 *   - /api/providers/9w/overview            (live withdrawable, turnover
 *                                            records, unmatched tickets)
 *   - /api/betting-accounts/recent-bets     (7-day feed: settled + pending
 *                                            merged from 9W main-site)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Info,
  Loader2,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Wallet,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ProgressItem } from "./MultiProgressList";
import { RecentBetsModal } from "./RecentBetsModal";

// ─────────────────────────────────────────────────────────────────────
// Shared types. Re-declared here (rather than imported from page.tsx)
// so the file's an island — page.tsx imports us, not the reverse.
// ─────────────────────────────────────────────────────────────────────

export type SessionHealth = "healthy" | "expiring" | "expired" | "unknown";

export interface BettingAccount {
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

/** Subset of /api/providers/9w/overview we actually read here. */
export interface Overview9W {
  providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null;
  mainSite: {
    withdrawable: number | null;
  } | null;
  turnover: {
    canWithdraw: boolean;
    recordsCount: number;
    records: unknown[];
  } | null;
  unmatchedTickets: Array<{ id: number }>;
  autoLogin: {
    enabled: boolean;
    reason: string | null;
    updatedAt: string;
  };
  errors: Record<string, string>;
}

/**
 * Optional enrichment attached by the API when a main-site bet matches
 * a row in our `placed_bets` table. Present only for bets placed
 * through our system (we reconcile `providerTicketId` to the book's
 * ticket id). UI falls back to `gameName` / `betType` when absent.
 */
export interface RecentBetEnrichment {
  placedBetId?: string;
  valueBetId?: string;
  eventName?: string;
  homeTeam?: string;
  awayTeam?: string;
  competition?: string;
  marketType?: string;
  atomLabel?: string;
}

export interface RecentBet {
  id: string;
  status: "settled" | "pending";
  placedAt: string;
  settledAt?: string;
  vendorId: number;
  vendorName: string;
  gameName: string;
  gameTypeId: number;
  stake: number;
  odds: number;
  profit?: number;
  turnover?: number;
  result?: "win" | "lose" | "void";
  betType: string;
  transactionId: number;
  vendorTxnId: string;
  enrichment?: RecentBetEnrichment;
}

interface RecentBetsResponse {
  periodDays: number;
  bets: RecentBet[];
  totals: {
    totalProfitLoss: number | null;
    totalTurnover: number | null;
    totalBetAmount: number | null;
    pendingCount: number;
    settledCount: number;
  };
  at: string;
  errors: Record<string, string>;
}

/**
 * Observed turnover record shape from
 * `/api/bt/v1/bonus/getTurnoverList`. Most numeric fields come back
 * as strings in the JSON — we coerce on read so the progress bar
 * renders correctly.
 *
 * Example:
 *   {
 *     bonusTurnoverId: 882051677,
 *     requirementTurnover: "2000",   // total required
 *     currentTurnover: "691.1",       // completed
 *     balanceTurnover: "1308.9",      // remaining
 *     initDepositAmount: "2000",      // deposit that created this
 *     endTimestamp: 3818419199000,
 *     bonusDetail: { bonusTitle: "Normal", bonusCode: "No_Bonus_BDT",
 *                    extraData: { titleI18n: { en: "Normal" } } }
 *   }
 */
interface TurnoverRecord {
  bonusTurnoverId?: number | string;
  requirementTurnover?: string | number;
  currentTurnover?: string | number;
  balanceTurnover?: string | number;
  initDepositAmount?: string | number;
  endTimestamp?: number;
  expiredTimestamp?: number;
  bonusDetail?: {
    bonusTitle?: string;
    bonusCode?: string;
    bonusDescription?: string;
    extraData?: {
      titleI18n?: Record<string, string>;
    };
  };
  [extra: string]: unknown;
}

export interface BettingAccountsPanelProps {
  accounts: BettingAccount[] | null;
  overview9W: Overview9W | null;
  onToggleAutoPlace: (provider: string, enabled: boolean) => void;
  onRelogin: (provider: string) => void;
  reloginInProgress: Set<string>;
  onToggleAutoLogin: (enabled: boolean) => void;
  autoLoginBusy: boolean;
}

const PROVIDER_COLOR: Record<string, string> = {
  "ninewickets-sportsbook": "text-amber-500",
  "ninewickets-exchange": "text-sky-500",
};

// ─────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────

export function BettingAccountsPanel(props: BettingAccountsPanelProps) {
  const { accounts } = props;

  // Recent bets feed — for the modal on each account card.
  const [recent, setRecent] = useState<RecentBetsResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/accounts/recent-bets");
        if (!res.ok) return;
        const body = (await res.json()) as RecentBetsResponse;
        if (!cancelled) setRecent(body);
      } catch {
        /* best effort */
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex flex-col h-full">
        {/* Sticky section header */}
        <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between shrink-0">
          <span className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground/50">
            Accounts
          </span>
          {accounts && accounts.length > 0 && (
            <span className="text-[10px] data-text text-muted-foreground/40 tabular-nums">
              {accounts.length}
            </span>
          )}
        </div>

        {/* Account cards */}
        <div className="flex-1 overflow-y-auto">
          {accounts === null ? (
            <AccountsSkeleton />
          ) : accounts.length === 0 ? (
            <div className="px-4 py-8 text-xs text-muted-foreground/60 text-center">
              No accounts configured.
            </div>
          ) : (
            <div className="divide-y divide-border/20">
              {accounts.map((account) => (
                <AccountCard
                  key={account.provider}
                  account={account}
                  overview={
                    account.provider === "ninewickets-sportsbook"
                      ? props.overview9W
                      : null
                  }
                  recent={recent}
                  onToggleAutoPlace={props.onToggleAutoPlace}
                  onRelogin={props.onRelogin}
                  reloginBusy={props.reloginInProgress.has(account.provider)}
                  onToggleAutoLogin={props.onToggleAutoLogin}
                  autoLoginBusy={props.autoLoginBusy}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card — the expanded per-account slide
// ─────────────────────────────────────────────────────────────────────

interface AccountCardProps {
  account: BettingAccount;
  overview: Overview9W | null;
  recent: RecentBetsResponse | null;
  onToggleAutoPlace: (provider: string, enabled: boolean) => void;
  onRelogin: (provider: string) => void;
  reloginBusy: boolean;
  onToggleAutoLogin: (enabled: boolean) => void;
  autoLoginBusy: boolean;
}

function AccountCard({
  account,
  overview,
  recent,
  onToggleAutoPlace,
  onRelogin,
  reloginBusy,
  onToggleAutoLogin,
  autoLoginBusy,
}: AccountCardProps) {
  const hasError = !!account.error;
  const dim = account.isDemo;
  // Treat accounts with zero/null balance and no error as "inactive"
  const isInactive =
    !hasError &&
    (account.balance === null || account.balance === 0) &&
    (account.exposure === null || account.exposure === 0);
  const canRelogin =
    !account.isDemo &&
    (hasError ||
      account.session.health === "expired" ||
      account.session.health === "expiring");

  const bettable = overview?.providerInfo?.betCredit ?? account.balance;
  const withdrawable = overview?.mainSite?.withdrawable ?? null;
  const exposure = overview?.providerInfo?.exposure ?? account.exposure;
  const turnoverInfo = overview?.turnover ?? null;
  const mainSiteErr = overview?.errors.mainSite ?? null;
  const turnoverErr = overview?.errors.turnover ?? null;
  const autoLogin = overview?.autoLogin ?? null;

  // Map turnover records → MultiProgressList items. The main-site ships
  // numeric fields as strings; coerce on read.
  const turnoverItems = useMemo<ProgressItem[]>(() => {
    if (!turnoverInfo || turnoverInfo.records.length === 0) return [];
    return turnoverInfo.records.map((raw, i) => {
      const r = raw as TurnoverRecord;
      const total = toNum(r.requirementTurnover) ?? 0;
      const current =
        toNum(r.currentTurnover) ??
        (total > 0 ? total - (toNum(r.balanceTurnover) ?? 0) : 0);
      const label =
        r.bonusDetail?.extraData?.titleI18n?.en ??
        r.bonusDetail?.bonusTitle ??
        r.bonusDetail?.bonusCode ??
        `Bonus ${i + 1}`;
      const deposit = toNum(r.initDepositAmount);
      const sublabelParts: string[] = [];
      if (deposit != null && deposit > 0) {
        sublabelParts.push(
          `Deposit ${account.currency} ${deposit.toLocaleString()}`,
        );
      }
      const expiryLabel = formatTurnoverExpiry(
        // `endTimestamp` on the record is the bonus window's close time.
        // Many accounts show a far-future sentinel (~year 2090) which we
        // treat as "no expiry" and suppress.
        r.endTimestamp && r.endTimestamp < Date.now() + 3 * 365 * 86_400_000
          ? r.endTimestamp
          : undefined,
      );
      if (expiryLabel) sublabelParts.push(expiryLabel);
      return {
        id: String(
          r.bonusTurnoverId ?? r.bonusDetail?.bonusCode ?? `turnover-${i}`,
        ),
        label: String(label),
        current,
        total,
        unit: account.currency,
        sublabel: sublabelParts.length > 0 ? sublabelParts.join(" · ") : null,
      };
    });
  }, [turnoverInfo, account.currency]);

  // Bets for this account only — filter by provider match.
  const accountBets = useMemo<RecentBet[]>(() => {
    if (!recent) return [];
    // The 9W sportsbook vendor is labelled "Exchange" (vendorName) at
    // the main site — map our providerId → vendorName.
    if (account.provider === "ninewickets-sportsbook") {
      return recent.bets.filter(
        (b) =>
          b.vendorName.toLowerCase() === "exchange" ||
          b.vendorName.toLowerCase().includes("sportsbook"),
      );
    }
    return [];
  }, [recent, account.provider]);

  const [betsModalOpen, setBetsModalOpen] = useState(false);

  // Turnover summary — pick the first active item for the inline bar.
  const activeTurnover = turnoverItems.length > 0 ? turnoverItems[0] : null;
  const turnoverPct =
    activeTurnover && activeTurnover.total > 0
      ? Math.min(1, activeTurnover.current / activeTurnover.total)
      : null;

  return (
    <div
      className={cn(
        "acc-card",
        hasError && "acc-card--error",
        isInactive && "acc-card--inactive",
        autoLogin && !autoLogin.enabled && "acc-card--paused",
        dim && "opacity-50",
      )}
    >
      {/* ── Card Header ── */}
      <div className="acc-card-header">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              "acc-provider-dot",
              hasError
                ? "bg-danger"
                : account.provider.includes("sportsbook")
                  ? "bg-amber-400"
                  : "bg-cyan-400",
            )}
          />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-foreground/90 truncate leading-tight">
              {account.providerDisplayName}
            </div>
            {account.username && (
              <div className="text-[10px] text-muted-foreground/40 data-text truncate">
                {account.username} · {formatRelative(account.lastSyncedAt)}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge account={account} reloginBusy={reloginBusy} />
          <SessionBadge session={account.session} isDemo={account.isDemo} />
        </div>
      </div>

      {/* ── Body: error, inactive, or stats ── */}
      {hasError ? (
        <div className="acc-card-body">
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-[11px] text-destructive flex items-start gap-2 leading-snug">
            <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
            <span className="break-all">{account.error}</span>
          </div>
        </div>
      ) : isInactive ? (
        <div className="acc-card-body">
          <div className="acc-inactive-banner">
            <span className="text-[11px] text-muted-foreground/40">
              No funds · not active
            </span>
          </div>
        </div>
      ) : (
        <div className="acc-card-body">
          {/* ── Primary balance ── */}
          <div className="acc-balance-row">
            <div className="acc-stat acc-stat--hero">
              <div className="acc-stat-label">Available</div>
              <div className="acc-stat-value acc-stat-value--hero text-emerald-400 data-text">
                {bettable !== null ? money(bettable, account.currency) : "—"}
              </div>
            </div>

            <div className="acc-stat">
              <div className="acc-stat-label">Withdrawable</div>
              {overview === null && !mainSiteErr ? (
                <Skeleton className="h-4 w-24 rounded mt-0.5" />
              ) : (
                <div
                  className={cn(
                    "acc-stat-value data-text",
                    Boolean(turnoverInfo && !turnoverInfo.canWithdraw)
                      ? "text-amber-400"
                      : "text-foreground/80",
                  )}
                >
                  {withdrawable !== null
                    ? money(withdrawable, account.currency)
                    : "—"}
                </div>
              )}
            </div>

            <div className="acc-stat">
              <div className="acc-stat-label">Exposure</div>
              <div
                className={cn(
                  "acc-stat-value data-text",
                  (exposure ?? 0) > 0 ? "text-amber-400" : "text-foreground/80",
                )}
              >
                {exposure !== null ? money(exposure, account.currency) : "—"}
              </div>
            </div>

            {account.minBet !== null && (
              <div className="acc-stat">
                <div className="acc-stat-label">Min Bet</div>
                <div className="acc-stat-value data-text text-foreground/60">
                  {money(account.minBet, account.currency)}
                </div>
              </div>
            )}
          </div>

          {/* ── Turnover — always visible when overview is relevant ── */}
          {(overview !== null || !turnoverErr) && (
            <div className="acc-turnover">
              <div className="acc-turnover-header">
                <span className="acc-stat-label">Turnover</span>
                {overview === null ? (
                  <Loader2 className="size-3 text-muted-foreground/30 animate-spin" />
                ) : activeTurnover ? (
                  <span className="text-[10px] data-text text-muted-foreground/60">
                    {activeTurnover.current.toLocaleString()} /{" "}
                    {activeTurnover.total.toLocaleString()} {account.currency} ·{" "}
                    {(turnoverPct! * 100).toFixed(0)}%
                  </span>
                ) : turnoverInfo?.canWithdraw ? (
                  <span className="text-[10px] text-emerald-400 font-medium">
                    ✓ Ready to withdraw
                  </span>
                ) : null}
              </div>
              {overview === null ? (
                <Skeleton className="h-1.5 w-full rounded-full" />
              ) : activeTurnover ? (
                <div className="acc-turnover-track">
                  <div
                    className={cn(
                      "acc-turnover-fill",
                      turnoverPct! >= 1
                        ? "bg-emerald-500"
                        : turnoverPct! >= 0.5
                          ? "bg-amber-400"
                          : "bg-danger",
                    )}
                    style={{ width: `${Math.min(100, turnoverPct! * 100)}%` }}
                  />
                </div>
              ) : (
                <div className="acc-turnover-track">
                  <div
                    className={cn(
                      "acc-turnover-fill",
                      turnoverInfo?.canWithdraw
                        ? "bg-emerald-500"
                        : "bg-muted/30",
                    )}
                    style={{ width: turnoverInfo?.canWithdraw ? "100%" : "0%" }}
                  />
                </div>
              )}
              {overview !== null && !activeTurnover && (
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                  {turnoverInfo?.canWithdraw
                    ? "No outstanding requirement"
                    : "No active bonus turnover"}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Controls footer ── */}
      <div className="acc-card-footer">
        <div className="flex items-center gap-1.5 flex-wrap">
          {autoLogin && !account.isDemo && (
            <AutoLoginToggle
              state={autoLogin}
              busy={autoLoginBusy}
              onToggle={onToggleAutoLogin}
            />
          )}
          {canRelogin && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
              disabled={reloginBusy}
              onClick={() => onRelogin(account.provider)}
            >
              {reloginBusy ? (
                <Loader2 className="size-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="size-3 mr-1" />
              )}
              Re-login
            </Button>
          )}
          {recent && accountBets.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setBetsModalOpen(true)}
            >
              <Eye className="size-3 mr-1" />
              {accountBets.length} bets
            </Button>
          )}
        </div>
        <AutoPlaceToggle
          provider={account.provider}
          enabled={account.autoPlaceEnabled}
          disabled={account.isDemo || hasError}
          onChange={onToggleAutoPlace}
        />
      </div>

      {/* Recent bets modal */}
      {recent && (
        <RecentBetsModal
          open={betsModalOpen}
          onOpenChange={setBetsModalOpen}
          bets={accountBets}
          currency={account.currency}
          periodDays={recent.periodDays}
          totals={{
            ...recent.totals,
            totalProfitLoss: sumOrNull(accountBets.map((b) => b.profit)),
            totalTurnover: sumOrNull(accountBets.map((b) => b.turnover)),
            totalBetAmount: accountBets.reduce((s, b) => s + (b.stake ?? 0), 0),
            pendingCount: accountBets.filter((b) => b.status === "pending")
              .length,
            settledCount: accountBets.filter((b) => b.status === "settled")
              .length,
          }}
          providerDisplayName={account.providerDisplayName}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Leaf components
// ─────────────────────────────────────────────────────────────────────

/**
 * Turnover tile — sits inline with the other balance tiles.
 *
 * Single-bonus: shows one progress bar with the "remaining to clear"
 * number front-and-centre and a live countdown sublabel.
 *
 * Multi-bonus: wraps the slides in a carousel with explicit chevron
 * buttons plus an aggregate "+N more" counter, so the operator can
 * tell at a glance that (a) there IS more than one bonus to page
 * through and (b) which one they're currently looking at. The old
 * dot-only nav was easy to miss.
 */
function TurnoverTile({
  items,
  canWithdraw,
  error,
  loading,
}: {
  items: ProgressItem[];
  canWithdraw: boolean;
  error: string | null;
  /** Overview hasn't returned yet. Render a shimmer placeholder so the
   *  operator doesn't read "None" while the fetch is still in flight. */
  loading?: boolean;
}) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    loop: items.length > 1,
    align: "start",
    containScroll: "trimSnaps",
  });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelected(emblaApi.selectedScrollSnap());
    onSelect();
    emblaApi.on("select", onSelect);
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi]);

  // Empty / error / ready states share the tile shell so the 4-column
  // grid stays visually aligned at all times.
  const renderShell = (
    content: React.ReactNode,
    tone: "ready" | "error" | "active" | "neutral" | "loading",
  ) => {
    const border =
      tone === "ready"
        ? "border-emerald-500/20 bg-emerald-500/[0.03]"
        : tone === "error"
          ? "border-amber-500/20 bg-amber-500/[0.03]"
          : tone === "active"
            ? "border-amber-500/25 bg-amber-500/[0.04]"
            : "balance-tile--default border-[oklch(1_0_0/5%)]";
    return (
      <div
        className={cn(
          "rounded-lg px-2.5 py-1.5 flex flex-col leading-tight gap-1 min-w-0 overflow-hidden h-full",
          border,
        )}
      >
        {content}
      </div>
    );
  };

  if (loading) {
    return renderShell(
      <>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
          <span className="truncate">Turnover</span>
          <Loader2 className="size-2.5 text-muted-foreground/70 shrink-0 animate-spin" />
        </div>
        <Skeleton className="h-3.5 w-2/3 mt-0.5 rounded" />
        <Skeleton className="h-2 w-1/2 rounded" />
        <Skeleton className="h-1 w-full rounded-full" />
      </>,
      "loading",
    );
  }

  if (error) {
    return renderShell(
      <>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
          Turnover
        </div>
        <div className="text-[10.5px] text-amber-500 truncate" title={error}>
          Couldn’t load
        </div>
      </>,
      "error",
    );
  }

  if (items.length === 0) {
    return renderShell(
      <>
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
          Turnover
        </div>
        <div className="text-xs font-semibold text-emerald-500">
          {canWithdraw ? "Ready to withdraw" : "None"}
        </div>
        <div className="text-[9px] text-muted-foreground">
          {canWithdraw ? "No outstanding turnover" : "No active bonus turnover"}
        </div>
      </>,
      canWithdraw ? "ready" : "neutral",
    );
  }

  const hasMultiple = items.length > 1;
  return renderShell(
    <>
      <div className="flex items-center gap-0.5 min-w-0">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground shrink-0">
          Turnover
        </span>
        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={() => emblaApi?.scrollPrev()}
              aria-label="Previous bonus"
              className="ml-auto inline-flex items-center justify-center size-3.5 rounded hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground transition shrink-0"
            >
              <ChevronLeft className="size-2.5" />
            </button>
            <span
              className="text-[9px] tabular-nums text-amber-500 shrink-0 px-0.5"
              title={`Bonus ${selected + 1} of ${items.length}`}
            >
              {selected + 1}/{items.length}
            </span>
            <button
              type="button"
              onClick={() => emblaApi?.scrollNext()}
              aria-label="Next bonus"
              className="inline-flex items-center justify-center size-3.5 rounded hover:bg-muted-foreground/10 text-muted-foreground hover:text-foreground transition shrink-0"
            >
              <ChevronRight className="size-2.5" />
            </button>
          </>
        )}
        {!hasMultiple && (
          <span className="ml-auto text-[9px] text-amber-500 shrink-0">
            1 active
          </span>
        )}
      </div>
      <div ref={emblaRef} className="overflow-hidden">
        <div className="flex">
          {items.map((item) => (
            <div
              key={item.id}
              className="shrink-0 grow-0 basis-full min-w-0 pr-0"
            >
              <TurnoverSlide item={item} />
            </div>
          ))}
        </div>
      </div>
    </>,
    "active",
  );
}

/**
 * A single turnover slide. Lays the info out in a way the operator
 * can read in one glance:
 *   line 1 — bonus name (small)
 *   line 2 — BIG "X remaining" or "Cleared" so it's the first number
 *            the eye lands on
 *   line 3 — progress bar + percent at right edge
 *   line 4 — tiny "X of Y cleared" sublabel for the full context
 */
function TurnoverSlide({ item }: { item: ProgressItem }) {
  const total = Math.max(item.total, 0);
  const current = Math.max(Math.min(item.current, total), 0);
  const remaining = Math.max(total - current, 0);
  const pct = total > 0 ? current / total : 0;
  const done = pct >= 1;
  const barColor = done
    ? "bg-emerald-500"
    : pct >= 0.8
      ? "bg-emerald-500/80"
      : pct >= 0.33
        ? "bg-amber-500"
        : "bg-danger";

  const unit = item.unit ? ` ${item.unit}` : "";
  const fmt = (n: number) =>
    n >= 10_000
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : n.toFixed(2);

  return (
    <div className="space-y-1 min-w-0">
      <div
        className="text-[10px] text-muted-foreground truncate"
        title={item.label}
      >
        {item.label}
      </div>
      <div
        className={cn(
          "text-xs font-semibold tabular-nums truncate",
          done ? "text-emerald-500" : "text-foreground",
        )}
      >
        {done ? (
          "Cleared"
        ) : (
          <>
            {fmt(remaining)}
            {unit}{" "}
            <span className="text-muted-foreground font-normal">to go</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <div
          className="h-1 flex-1 rounded-full bg-muted overflow-hidden"
          title={item.tooltip}
        >
          <div
            className={cn("h-full rounded-full transition-all", barColor)}
            style={{ width: `${Math.min(100, pct * 100)}%` }}
          />
        </div>
        <span
          className={cn(
            "text-[9px] tabular-nums shrink-0",
            done ? "text-emerald-500" : "text-muted-foreground",
          )}
        >
          {(pct * 100).toFixed(0)}%
        </span>
      </div>
      <div className="text-[9px] tabular-nums text-muted-foreground truncate">
        {fmt(current)} / {fmt(total)}
        {unit} cleared
      </div>
    </div>
  );
}

function BalanceTile({
  label,
  value,
  currency,
  valueClass,
  big,
  errorHint,
  locked,
  lockedHint,
  loading,
}: {
  label: string;
  value: number | null;
  currency: string;
  valueClass?: string;
  big?: boolean;
  errorHint?: string | null;
  /** When true, render a lock overlay on the value to signal the
   *  balance is present but blocked (e.g. turnover incomplete). */
  locked?: boolean;
  lockedHint?: string | null;
  /** When true, suppresses the "—" placeholder and renders a shimmer
   *  bar instead. Useful for fields that arrive over a separate slow
   *  fetch (e.g. the main-site /overview call) so the operator can
   *  distinguish "still loading" from "no data". */
  loading?: boolean;
}) {
  const effectiveValueClass = locked ? "text-muted-foreground/70" : valueClass;
  const isLoading = Boolean(loading) && value === null;
  // `h-full` is critical — grid cells stretch to the tallest tile
  // (turnover with its progress bar), but without h-full the bordered
  // div inside shrinks to its content, leaving tiles with visually
  // inconsistent heights.
  const core = (
    <div
      className={cn(
        "fintech-stat flex flex-col leading-tight gap-0.5 min-w-0 h-full",
        locked ? "fintech-stat--locked" : "",
      )}
    >
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
        <span className="truncate">{label}</span>
        {locked && !isLoading && (
          <Lock className="size-2.5 text-amber-500 shrink-0" />
        )}
        {errorHint && !locked && !isLoading && (
          <Info className="size-2.5 text-amber-500 shrink-0" />
        )}
        {isLoading && (
          <Loader2 className="size-2.5 text-muted-foreground/70 shrink-0 animate-spin" />
        )}
      </div>
      {isLoading ? (
        <Skeleton
          className={cn("w-3/4 rounded", big ? "h-4 mt-0.5" : "h-3.5 mt-0.5")}
        />
      ) : (
        <div
          className={cn(
            "data-text font-medium truncate",
            big ? "text-base font-semibold" : "text-sm",
            value === null && "text-muted-foreground",
            effectiveValueClass,
          )}
        >
          {value === null ? "—" : money(value, currency)}
        </div>
      )}
      {locked && !isLoading && (
        <div className="text-[9px] text-amber-500/90 truncate">
          Turnover pending
        </div>
      )}
    </div>
  );
  const hint = isLoading ? null : (errorHint ?? lockedHint);
  if (!hint) return core;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="cursor-help">{core}</div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] text-[10px]">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One half of the Pending | Settled layout — a labelled mini-list of
 * bet preview rows. Self-contained so the parent just passes the
 * pre-filtered slice; click anywhere inside opens the full-history
 * modal via `onOpenModal`.
 */
function BetColumn({
  title,
  accent,
  bets,
  extra,
  totalLabel,
  currency,
  periodDays,
  emptyText,
  loading,
  onOpenModal,
}: {
  title: string;
  accent: "amber" | "neutral";
  bets: RecentBet[];
  extra: number;
  totalLabel: string | null;
  currency: string;
  periodDays: number | null;
  emptyText: string | null;
  loading: boolean;
  onOpenModal: () => void;
}) {
  const labelColor =
    accent === "amber" ? "text-amber-500" : "text-muted-foreground";
  // Column grows to fill the grid-row height so empty/populated columns
  // sit side-by-side at the same height. The body panel inside takes
  // the slack via flex-1, which keeps the sibling's 3 rows lined up
  // with this side's empty/centered message.
  return (
    <div className="flex flex-col h-full gap-1.5">
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold",
            labelColor,
          )}
        >
          {title}
          {periodDays != null && (
            <span className="ml-1 text-muted-foreground font-normal normal-case tracking-normal">
              ({periodDays}d)
            </span>
          )}
        </div>
        {totalLabel && (
          <span className="text-[10px] text-muted-foreground">
            {totalLabel}
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex-1 rounded-lg border border-border/20 bg-background/15 min-h-[140px] overflow-hidden space-y-0">
          {/* Skeleton bet rows — mimics the actual row structure to
              prevent height jumps when real data arrives. */}
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="px-2.5 py-2 border-b border-border/20">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-11 rounded" />
                <Skeleton className="h-3.5 flex-1 rounded" />
                <Skeleton className="h-3.5 w-20 rounded" />
              </div>
              <div className="mt-1.5 pl-[52px]">
                <Skeleton className="h-2.5 w-3/4 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : bets.length === 0 ? (
        <div className="flex-1 rounded-lg border border-border/20 bg-background/10 px-2 py-3 text-[11px] text-muted-foreground/60 flex items-center justify-center text-center min-h-[140px]">
          {emptyText}
        </div>
      ) : (
        <BetList
          bets={bets}
          currency={currency}
          extra={extra}
          onOpenModal={onOpenModal}
        />
      )}
    </div>
  );
}

/**
 * Reusable bet-row list. Rows are denser than the old unified-feed
 * layout because each column is now half-width — every line of real
 * estate counts. The "+N more" affordance rides as the list's own
 * footer row inside the same border so it reads as part of the list.
 *
 * Used for both Pending and Settled columns — one component, one set
 * of spacing tweaks that apply to both sides.
 */
function BetList({
  bets,
  currency,
  extra,
  onOpenModal,
}: {
  bets: RecentBet[];
  currency: string;
  extra: number;
  onOpenModal: () => void;
}) {
  return (
    <div className="flex-1 rounded-lg border border-border/20 bg-background/10 divide-y divide-border/20 overflow-hidden">
      {bets.map((bet) => (
        <button
          key={bet.id}
          type="button"
          onClick={onOpenModal}
          className="w-full text-left px-2.5 py-2 hover:bg-muted/30 transition-colors block"
        >
          <BetPreviewRow bet={bet} currency={currency} />
        </button>
      ))}
      {extra > 0 && (
        <button
          type="button"
          onClick={onOpenModal}
          className="w-full text-[11px] text-muted-foreground/60 hover:text-foreground hover:bg-muted/30 transition-colors text-center py-1.5 block"
        >
          + {extra} more — view all
        </button>
      )}
    </div>
  );
}

/**
 * Two-line bet preview tuned for half-width columns.
 *
 *   Line 1: [status pill]  Home vs Away              +BDT 51.17
 *   Line 2: 6h · Match Odds · Home · BDT 119 @ 1.43
 *
 * When the API enrichment is present (bet placed through our system,
 * matched via reconciler), we prefer `homeTeam` / `awayTeam` and the
 * normalized `marketType` + `atomLabel` for the richer labels.
 * Otherwise we fall back to the main-site's `gameName` + `betType`
 * pair so third-party bets still render.
 *
 * For pending bets we swap P&L for "potential return" (stake * (odds-1))
 * so the operator sees what they stand to win, instead of a dangling
 * em-dash.
 */
function BetPreviewRow({
  bet,
  currency,
}: {
  bet: RecentBet;
  currency: string;
}) {
  const placedAgo = formatRelative(bet.placedAt);
  const resultLabel =
    bet.status === "pending"
      ? "Pending"
      : bet.result === "win"
        ? "Win"
        : bet.result === "lose"
          ? "Lose"
          : "Void";
  const resultClass =
    bet.status === "pending"
      ? "text-amber-500 border-amber-500/40"
      : bet.result === "win"
        ? "text-emerald-400 border-emerald-500/40"
        : bet.result === "lose"
          ? "text-danger border-danger/40"
          : "text-muted-foreground";

  const e = bet.enrichment;
  const primaryLabel =
    e?.homeTeam && e?.awayTeam
      ? `${e.homeTeam} vs ${e.awayTeam}`
      : (e?.eventName ?? bet.gameName);
  const marketLabel = e?.marketType ?? bet.betType;
  const selectionLabel = e?.atomLabel ?? null;

  const metaParts: string[] = [];
  if (placedAgo) metaParts.push(placedAgo);
  if (marketLabel) metaParts.push(marketLabel);
  if (selectionLabel) metaParts.push(selectionLabel);
  const hasStake = bet.stake != null;
  const oddsText =
    typeof bet.odds === "number" && Number.isFinite(bet.odds)
      ? ` @ ${bet.odds.toFixed(2)}`
      : "";
  if (hasStake) metaParts.push(`${money(bet.stake, currency)}${oddsText}`);

  // Right-hand value: P&L for settled, potential return for pending.
  const potentialReturn =
    bet.status === "pending" &&
    hasStake &&
    typeof bet.odds === "number" &&
    Number.isFinite(bet.odds) &&
    bet.odds > 1
      ? bet.stake * (bet.odds - 1)
      : null;

  return (
    <div className="flex flex-col gap-0.5 w-full min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <Badge
          variant="outline"
          className={cn(
            "text-[9px] h-4 px-1.5 justify-center shrink-0 w-[46px]",
            resultClass,
          )}
        >
          {resultLabel}
        </Badge>
        <span className="text-xs font-medium text-foreground/90 truncate flex-1 min-w-0">
          {primaryLabel || "—"}
        </span>
        {bet.profit != null ? (
          <span
            className={cn(
              "text-xs data-text font-semibold text-right shrink-0",
              bet.profit > 0
                ? "text-emerald-400"
                : bet.profit < 0
                  ? "text-danger"
                  : "text-foreground",
            )}
          >
            {bet.profit > 0 ? "+" : ""}
            {money(bet.profit, currency)}
          </span>
        ) : potentialReturn != null ? (
          <span
            className="text-xs data-text text-muted-foreground/70 text-right shrink-0"
            title="Potential return if this bet wins"
          >
            +{money(potentialReturn, currency)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground text-right shrink-0">
            —
          </span>
        )}
      </div>
      {metaParts.length > 0 && (
        <div className="text-[10.5px] text-muted-foreground/70 truncate pl-[54px] leading-tight">
          {metaParts.join(" · ")}
        </div>
      )}
    </div>
  );
}

function SessionBadge({
  session,
  isDemo,
}: {
  session: BettingAccount["session"];
  isDemo: boolean;
}) {
  if (isDemo) return null;
  const ms = session.msUntilExpiry;
  const label = formatSessionWindow(ms);
  const title =
    session.expiresAt && session.capturedAt
      ? `Session captured ${new Date(session.capturedAt).toLocaleString()} · expires ${new Date(session.expiresAt).toLocaleString()}`
      : "No session captured yet";
  switch (session.health) {
    case "healthy":
      return (
        <Badge
          variant="outline"
          className="text-[9px] h-4 px-1.5 text-emerald-600 border-emerald-600/40"
          title={title}
        >
          Session {label}
        </Badge>
      );
    case "expiring":
      return (
        <Badge
          variant="outline"
          className="text-[9px] h-4 px-1.5 text-amber-600 border-amber-600/40"
          title={title}
        >
          Expires {label}
        </Badge>
      );
    case "expired":
      return (
        <Badge
          variant="destructive"
          className="text-[9px] h-4 px-1.5"
          title={title}
        >
          Expired
        </Badge>
      );
    default:
      return (
        <Badge
          variant="outline"
          className="text-[9px] h-4 px-1.5 text-muted-foreground"
          title={title}
        >
          No session
        </Badge>
      );
  }
}

function StatusBadge({
  account,
  reloginBusy,
}: {
  account: BettingAccount;
  reloginBusy: boolean;
}) {
  // While a relogin is in flight (either the operator clicked the
  // button, or the dashboard auto-fired it in response to an auth
  // error) show "Reconnecting…" instead of the stale Error state.
  // Amber + pulse tells the operator "we see the problem, working
  // on it" without the alarm red of a real error.
  if (reloginBusy) {
    return (
      <Badge
        variant="outline"
        className="text-[9px] h-4 px-1.5 text-amber-500 border-amber-500/40 animate-pulse"
      >
        Reconnecting…
      </Badge>
    );
  }
  if (account.error) {
    return (
      <Badge variant="destructive" className="text-[9px] h-4 px-1.5">
        Error
      </Badge>
    );
  }
  if (account.suspended) {
    return (
      <Badge variant="destructive" className="text-[9px] h-4 px-1.5">
        Suspended
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[9px] h-4 px-1.5 text-emerald-600 border-emerald-600/40"
    >
      Active
    </Badge>
  );
}

function AutoLoginToggle({
  state,
  busy,
  onToggle,
}: {
  state: Overview9W["autoLogin"];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = state.enabled;
  const rel = renderAutoLoginAge(state.updatedAt);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-5 px-1.5 text-[9px] gap-0.5",
            enabled ? "text-emerald-500" : "text-amber-500",
          )}
          disabled={busy}
          onClick={() => onToggle(!enabled)}
        >
          {busy ? (
            <Loader2 className="size-2.5 animate-spin" />
          ) : enabled ? (
            <Pause className="size-2.5" />
          ) : (
            <Play className="size-2.5" />
          )}
          <span>{enabled ? "Auto-login ON" : "Auto-login PAUSED"}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-[10px]">
        {enabled ? (
          <>
            Auto-login is ON — session refreshes automatically when it expires.{" "}
            <b>Pause before logging in manually</b> on 9W (single-session rule —
            one active login per account).
            {rel && <div className="mt-1 opacity-70">Last change: {rel}</div>}
          </>
        ) : (
          <>
            Auto-login is <b>PAUSED</b> — background re-login is disabled.{" "}
            {state.reason ? `(${state.reason}) ` : ""}Resume so dashboard data
            keeps refreshing.
            {rel && <div className="mt-1 opacity-70">Paused {rel}</div>}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function AutoPlaceToggle({
  provider,
  enabled,
  disabled,
  onChange,
}: {
  provider: string;
  enabled: boolean;
  disabled?: boolean;
  onChange: (provider: string, enabled: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          className={cn(
            "inline-flex items-center gap-2 select-none rounded-md border pl-2 pr-1.5 py-1 transition-colors",
            disabled
              ? "opacity-50 cursor-not-allowed border-border/60"
              : enabled
                ? "cursor-pointer border-emerald-500/50 bg-emerald-500/10 hover:bg-emerald-500/15"
                : "cursor-pointer border-border/60 hover:bg-muted/60",
          )}
        >
          <Zap
            className={cn(
              "size-3",
              enabled ? "text-emerald-500" : "text-muted-foreground",
            )}
          />
          <span
            className={cn(
              "text-[10px] uppercase tracking-wide font-semibold leading-none",
              enabled ? "text-emerald-500" : "text-muted-foreground",
            )}
          >
            Auto-place
          </span>
          <span
            className={cn(
              "relative inline-block w-7 h-4 rounded-full transition-colors",
              enabled ? "bg-emerald-500" : "bg-muted",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-background transition-transform",
                enabled && "translate-x-3",
              )}
            />
          </span>
          <input
            type="checkbox"
            className="sr-only"
            checked={enabled}
            disabled={disabled}
            onChange={(e) => onChange(provider, e.target.checked)}
          />
        </label>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-[10px]">
        {disabled
          ? "Auto-place unavailable for this account"
          : enabled
            ? "Detected value bets are submitted to the book automatically. Flip off to require manual click-to-place."
            : "Currently manual-only — value bets wait for an operator click. Flip on to auto-submit."}
      </TooltipContent>
    </Tooltip>
  );
}

function AccountsSkeleton() {
  return (
    <div className="space-y-1.5">
      {/* First card — expanded skeleton */}
      <div className="fintech-card overflow-hidden">
        <div className="px-3 py-2.5 flex items-center gap-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-28 rounded" />
          <div className="ml-auto flex items-center gap-1.5">
            <Skeleton className="h-4 w-12 rounded-full" />
            <Skeleton className="size-3.5 rounded" />
          </div>
        </div>
        <div className="px-3 pb-3 space-y-3">
          <div className="space-y-1">
            <Skeleton className="h-2.5 w-20 rounded" />
            <Skeleton className="h-6 w-32 rounded" />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Skeleton className="h-[44px] rounded-lg" />
            <Skeleton className="h-[44px] rounded-lg" />
          </div>
          <Skeleton className="h-1 w-full rounded-full" />
          <div className="border-t border-border/30 pt-2 flex items-center gap-2">
            <Skeleton className="h-5 w-16 rounded" />
            <Skeleton className="h-5 w-16 rounded" />
            <div className="ml-auto">
              <Skeleton className="h-5 w-20 rounded" />
            </div>
          </div>
        </div>
      </div>
      {/* Second card — collapsed skeleton */}
      <div className="fintech-card overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-4 w-24 rounded" />
          <Skeleton className="h-4 w-20 rounded ml-auto" />
          <Skeleton className="size-3.5 rounded" />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────

function money(n: number | null, currency: string): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatSessionWindow(ms: number | null): string {
  if (ms === null) return "—";
  if (ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remM = mins % 60;
  return remM ? `${hours}h${remM}m` : `${hours}h`;
}

function renderAutoLoginAge(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 86_400_000) return null;
  return formatRelative(iso);
}

function formatTurnoverExpiry(endTimestamp: number | undefined): string | null {
  if (typeof endTimestamp !== "number" || !Number.isFinite(endTimestamp)) {
    return null;
  }
  const msLeft = endTimestamp - Date.now();
  if (msLeft <= 0) return "Expired";
  const day = Math.floor(msLeft / 86_400_000);
  if (day > 1) return `Expires in ${day}d`;
  const hr = Math.floor(msLeft / 3_600_000);
  if (hr >= 1) return `Expires in ${hr}h`;
  const min = Math.floor(msLeft / 60_000);
  return `Expires in ${min}m`;
}

function sumOrNull(nums: Array<number | undefined>): number | null {
  const finite = nums.filter((n): n is number => typeof n === "number");
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0);
}

/** The 9W main-site ships several turnover fields as JSON strings. */
function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
