"use client";

import { useState } from "react";
import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInSeconds,
  isAfter,
  parseISO,
} from "date-fns";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
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
import { ProviderBetsDialog } from "./ProviderBetsDialog";


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
  };
}

export interface Overview9W {
  providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null;
  unmatchedTickets: Array<{ id: number }>;
  autoLogin: {
    enabled: boolean;
    reason: string | null;
    updatedAt: string;
  };
  errors: Record<string, string>;
}

export interface OverviewVelki {
  providerInfo: {
    betCredit: number;
    exposure: number;
    suspended: boolean;
    minBet: number;
  } | null;
  autoLogin: {
    enabled: boolean;
    reason: string | null;
    updatedAt: string;
  };
  errors: Record<string, string>;
}

export interface ProviderStats {
  stake: number;
  openStake: number;
  openBets: number;
  settledBets: number;
}

export interface BettingAccountsPanelProps {
  accounts: BettingAccount[] | null;
  stats: {
    byBook: {
      key: string;
      stake: number;
      openStake: number;
      openBets: number;
      settledBets: number;
    }[];
  } | null;
  overview9W: Overview9W | null;
  overviewVelki: OverviewVelki | null;
  onToggleAutoPlace: (provider: string, enabled: boolean) => void;
  onRelogin: (provider: string) => void;
  reloginInProgress: Set<string>;
  onToggleAutoLogin: (provider: string, enabled: boolean) => void;
  autoLoginBusy: Set<string>;
}


export function BettingAccountsPanel(props: BettingAccountsPanelProps) {
  const { accounts, stats } = props;

  return (
    <TooltipProvider delayDuration={120}>
      {accounts === null ? (
        <AccountsSkeleton />
      ) : accounts.length === 0 ? (
        <div className="px-4 py-8 text-xs text-muted-foreground/60 text-center">
          No accounts configured.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((account) => {
            const providerStats = stats?.byBook.find(
              (b) => b.key === account.provider,
            );

            return (
              <AccountCard
                key={account.provider}
                account={account}
                overview={pickOverview(
                  account.provider,
                  props.overview9W,
                  props.overviewVelki,
                )}
                providerStats={providerStats}
                onToggleAutoPlace={props.onToggleAutoPlace}
                onRelogin={props.onRelogin}
                reloginBusy={props.reloginInProgress.has(account.provider)}
                onToggleAutoLogin={props.onToggleAutoLogin}
                autoLoginBusy={props.autoLoginBusy.has(account.provider)}
              />
            );
          })}
        </div>
      )}
    </TooltipProvider>
  );
}

function pickOverview(
  provider: string,
  overview9W: Overview9W | null,
  overviewVelki: OverviewVelki | null,
): Overview9W | null {
  if (provider === "ninewickets-sportsbook") return overview9W;
  if (provider === "velki-sportsbook") {
    if (!overviewVelki) return null;
    return {
      providerInfo: overviewVelki.providerInfo,
      unmatchedTickets: [],
      autoLogin: overviewVelki.autoLogin,
      errors: overviewVelki.errors,
    };
  }
  return null;
}


interface AccountCardProps {
  account: BettingAccount;
  overview: Overview9W | null;
  providerStats?: ProviderStats;
  onToggleAutoPlace: (provider: string, enabled: boolean) => void;
  onRelogin: (provider: string) => void;
  reloginBusy: boolean;
  onToggleAutoLogin: (provider: string, enabled: boolean) => void;
  autoLoginBusy: boolean;
}

function AccountCard({
  account,
  overview,
  providerStats,
  onToggleAutoPlace,
  onRelogin,
  reloginBusy,
  onToggleAutoLogin,
  autoLoginBusy,
}: AccountCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogStatus, setDialogStatus] = useState<
    "pending" | "settled" | null
  >(null);

  const openDialog = (status: "pending" | "settled") => {
    setDialogStatus(status);
    setDialogOpen(true);
  };

  const hasError = !!account.error;
  const dim = account.isDemo;
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
  const exposure = overview?.providerInfo?.exposure ?? account.exposure;
  const autoLogin = overview?.autoLogin ?? null;

  return (
    <div
      className={cn(
        "p-0 rounded-[14px] border border-white/[0.08] bg-card/60 shadow-sm transition-colors overflow-hidden relative",
        hasError && "border-danger/40 bg-danger/[0.02]",
        isInactive && "opacity-50 grayscale-[0.5]",
        autoLogin &&
          !autoLogin.enabled &&
          "border-amber-400/30 bg-amber-400/[0.02]",
        dim && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white/[0.02] border-b border-white/[0.04]">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              "size-2 rounded-full shrink-0 shadow-[0_0_8px_currentColor]",
              hasError
                ? "bg-danger"
                : account.provider.includes("sportsbook")
                  ? "bg-amber-400"
                  : "bg-cyan-400",
            )}
          />
          <div className="min-w-0">
            <div className="text-[14px] font-bold text-foreground/90 truncate leading-none">
              {account.providerDisplayName}
            </div>
            {account.username && (
              <div className="text-[10.5px] text-muted-foreground/50 font-mono tabular-nums tracking-tight truncate mt-1">
                {account.username} · {formatRelative(account.lastSyncedAt)}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <StatusBadge account={account} reloginBusy={reloginBusy} />
        </div>
      </div>

      {hasError ? (
        <div className="px-4 py-3 flex flex-col gap-2.5">
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-[12px] text-destructive flex items-start gap-2.5 leading-snug">
            <AlertCircle className="size-4 shrink-0 mt-0.5" />
            <span className="break-all">{account.error}</span>
          </div>
        </div>
      ) : isInactive ? (
        <div className="px-4 py-3 flex flex-col gap-2.5">
          <div className="px-3 py-4 rounded-lg bg-black/20 border border-dashed border-white/[0.08] flex items-center justify-center">
            <span className="text-[12px] text-muted-foreground/50 font-medium">
              No funds · not active
            </span>
          </div>
        </div>
      ) : (
        <div className="px-4 py-3.5 flex flex-col gap-2">
          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1 px-3 py-2.5 rounded-[8px] bg-black/20 border border-white/[0.04]">
              <div className="text-[9px] font-bold tracking-[0.08em] uppercase text-muted-foreground/70">
                Available
              </div>
              <div className="text-[16px] font-bold leading-none tracking-[-0.02em] text-emerald-400 font-mono tabular-nums mt-0.5">
                {bettable !== null ? money(bettable, account.currency) : "—"}
              </div>
            </div>

            <div className="flex flex-col gap-1 px-3 py-2.5 rounded-[8px] bg-black/20 border border-white/[0.04]">
              <div className="text-[9px] font-bold tracking-[0.08em] uppercase text-muted-foreground/70">
                Exposure
              </div>
              <div
                className={cn(
                  "text-[13px] font-semibold leading-none tracking-[-0.01em] font-mono tabular-nums mt-1",
                  (exposure ?? 0) > 0 ? "text-amber-400" : "text-foreground/80",
                )}
              >
                {exposure !== null ? money(exposure, account.currency) : "—"}
              </div>
            </div>

            <PendingTurnoverTile
              openStake={providerStats?.openStake ?? null}
              currency={account.currency}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div
              onClick={() => openDialog("pending")}
              className="flex items-center justify-between px-3.5 py-2.5 rounded-[8px] bg-black/20 border border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors group"
            >
              <div className="text-[10px] font-bold tracking-[0.08em] uppercase text-muted-foreground/70 group-hover:text-foreground/80 transition-colors">
                Pending Bets
              </div>
              <div className="text-[15px] font-bold leading-none font-mono tabular-nums text-amber-400">
                {providerStats ? providerStats.openBets : "—"}
              </div>
            </div>

            <div
              onClick={() => openDialog("settled")}
              className="flex items-center justify-between px-3.5 py-2.5 rounded-[8px] bg-black/20 border border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors group"
            >
              <div className="text-[10px] font-bold tracking-[0.08em] uppercase text-muted-foreground/70 group-hover:text-foreground/80 transition-colors">
                Settled Bets
              </div>
              <div className="text-[15px] font-bold leading-none font-mono tabular-nums text-cyan-400">
                {providerStats ? providerStats.settledBets : "—"}
              </div>
            </div>
          </div>
        </div>
      )}

      <ProviderBetsDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={account.provider}
        providerDisplayName={account.providerDisplayName}
        status={dialogStatus}
      />

      <div className="flex items-center justify-between gap-2 px-4 pt-1.5 pb-2.5 border-t border-white/[0.05] bg-black/10">
        <div className="flex items-center gap-1.5 flex-wrap">
          {autoLogin && !account.isDemo && (
            <AutoLoginToggle
              state={autoLogin}
              busy={autoLoginBusy}
              onToggle={(enabled) =>
                onToggleAutoLogin(account.provider, enabled)
              }
              providerLabel={account.providerDisplayName}
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
        </div>
        <AutoPlaceToggle
          provider={account.provider}
          enabled={account.autoPlaceEnabled}
          disabled={account.isDemo || hasError}
          onChange={onToggleAutoPlace}
        />
      </div>
    </div>
  );
}


function PendingTurnoverTile({
  openStake,
  currency,
}: {
  openStake: number | null;
  currency: string;
}) {
  const cleared = openStake !== null && openStake === 0;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2.5 rounded-[8px] border",
        cleared
          ? "bg-emerald-950/20 border-emerald-500/25"
          : "bg-black/20 border-white/[0.04]",
      )}
    >
      <div
        className={cn(
          "text-[9px] font-bold tracking-[0.08em] uppercase",
          cleared ? "text-emerald-400/80" : "text-muted-foreground/70",
        )}
      >
        Pending T.O.
      </div>

      {cleared ? (
        <div className="flex items-center gap-1.5 mt-0.5">
          <CheckCircle2 className="size-3 text-emerald-400" />
          <span className="text-[13px] font-semibold leading-none tracking-[-0.01em] text-emerald-400">
            Cleared
          </span>
        </div>
      ) : (
        <div className="text-[13px] font-semibold leading-none tracking-[-0.01em] font-mono tabular-nums text-foreground/80 mt-1">
          {openStake !== null ? money(openStake, currency) : "—"}
        </div>
      )}
    </div>
  );
}


function StatusBadge({
  account,
  reloginBusy,
}: {
  account: BettingAccount;
  reloginBusy: boolean;
}) {
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
  providerLabel,
}: {
  state: Overview9W["autoLogin"];
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  providerLabel: string;
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
            <b>Pause before logging in manually</b> on {providerLabel}{" "}
            (single-session rule — one active login per account).
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
    <div className="flex flex-col gap-3">
      {[1, 2].map((i) => (
        <div
          key={i}
          className="p-0 rounded-[14px] border border-white/[0.08] bg-card/60 shadow-sm overflow-hidden"
        >
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-white/[0.02] border-b border-white/[0.04]">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-2 rounded-full" />
              <div>
                <Skeleton className="h-3.5 w-24 mb-1.5 rounded-sm" />
                <Skeleton className="h-2.5 w-32 rounded-sm" />
              </div>
            </div>
            <div className="flex gap-1.5">
              <Skeleton className="h-4 w-12 rounded-sm" />
              <Skeleton className="h-4 w-16 rounded-sm" />
            </div>
          </div>
          <div className="px-4 py-3.5 flex flex-col gap-2">
            <div className="grid grid-cols-3 gap-2">
              <Skeleton className="h-[54px] rounded-[8px] opacity-60" />
              <Skeleton className="h-[54px] rounded-[8px] opacity-60" />
              <Skeleton className="h-[54px] rounded-[8px] opacity-60" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Skeleton className="h-[46px] rounded-[8px] opacity-60" />
              <Skeleton className="h-[46px] rounded-[8px] opacity-60" />
            </div>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.05] bg-black/10">
            <Skeleton className="h-5 w-28 rounded-sm" />
            <Skeleton className="h-5 w-20 rounded-sm" />
          </div>
        </div>
      ))}
    </div>
  );
}


function money(n: number | null, currency: string): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const date = parseISO(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const seconds = differenceInSeconds(now, date);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = differenceInMinutes(now, date);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = differenceInHours(now, date);
  if (hours < 24) return `${hours}h ago`;
  return `${differenceInDays(now, date)}d ago`;
}

function renderAutoLoginAge(iso: string): string | null {
  const date = parseISO(iso);
  if (Number.isNaN(date.getTime()) || !isAfter(date, new Date(0))) return null;
  return formatRelative(iso);
}
