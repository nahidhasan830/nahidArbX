"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

import { Badge } from "@/components/ui/badge";
import { Copy, Clock, ArrowRight, TrendingUp, Settings2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
  getProviderShortName,
  getSoftProviders,
  getProviderCommission,
  type ProviderKey,
} from "@/lib/providers/registry";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "@/lib/betting/configured-ids";
import { KELLY_FRACTION, VALUE_TOTAL_STAKE } from "@/lib/shared/constants";
import { adjustOddsForCommission } from "@/lib/shared/commission";
import { PlaceBetPanel } from "@/components/betting/PlaceBetPanel";
import { computeStake } from "@/lib/betting/sizing";
import {
  useBettingSettings,
  type BettingSettingsClient,
} from "@/hooks/use-betting-settings";

// Platform-wide currency. The whole app reports in BDT — see CLAUDE.md.
// If we ever support a second currency this gets plumbed per-account, but
// today every display should read as BDT regardless of what the provider
// API labeled it.
const DISPLAY_CURRENCY = "BDT";

// Floor below which Kelly-sized stakes get clamped up to the book's
// market minimum. Kelly on a small bankroll often suggests
// sub-practical amounts (3 BDT, 7 BDT) that are both useless in real
// terms AND below every book's per-ticket minimum. The rule: if Kelly
// falls below 119 BDT *or* below the per-market min, we auto-clamp up
// to the market min. User-entered values are still respected above
// this floor.
const UI_MIN_STAKE_FLOOR = 119;

// How often the place-bet panel re-fetches min/max/balance while the
// operator has the modal open. Short enough that a book changing the
// limit mid-session (e.g. pre-match → in-play) becomes visible; long
// enough not to hammer the adapter.
const LIMITS_REFRESH_MS = 15_000;

// ============================================
// Types
// ============================================

export interface ValueBetDetails {
  sharpProvider: ProviderKey;
  sharpOdds: number;
  trueProb: number;
  softProvider: ProviderKey;
  softOdds: number;
  adjustedSoftOdds?: number; // Commission-adjusted odds
  impliedProb: number;
  edge: number;
  evPct: number;
  kellyFraction: number;
  kellyStake: number;
  commissionPct?: number; // Commission percentage applied
  timestamp: number;
  familyOdds?: {
    totalImpliedProb: number;
    vigPct: number;
    atoms: {
      atomId: string;
      label: string;
      rawOdds: number;
      rawProb: number;
      trueProb: number;
    }[];
  };
}

export interface AtomOddsData {
  value: number;
  timestamp: number;
  isBest?: boolean;
  suspended?: boolean;
}

export interface LiveMatchInfo {
  home: number;
  away: number;
  minute: number;
  period: string;
  homeRedCards: number;
  awayRedCards: number;
  primarySource?: "pinnacle" | "betconstruct";
  confidence?: "high" | "medium" | "low" | "stale";
  hasDiscrepancy?: boolean;
  alternativeScore?: {
    source: "pinnacle" | "betconstruct";
    home: number;
    away: number;
  };
}

/**
 * Opt-in context that enables the "Place Bet" action inside the modal.
 * When omitted, the modal renders as a read-only inspector (existing
 * behavior). When provided, the footer surfaces a stake editor + Place
 * button that posts to /api/bets/place with a runtime descriptor.
 */
export interface PlacementContext {
  familyId: string;
  atomId: string;
  atomLabel: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  eventStartTime: string;
  competition?: string | null;
}

interface ValueBetDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventLabel: string;
  competition: string;
  startTime: string;
  marketLabel: string;
  outcomeLabel: string;
  details: ValueBetDetails | null;
  atomOdds?: Partial<Record<ProviderKey, AtomOddsData>>;
  eventId?: string;
  providerEventIds?: Record<string, string>;
  liveScore?: LiveMatchInfo;
  placementContext?: PlacementContext;
}

// Selection can be a provider key or "custom"
type Selection = ProviderKey | "custom";

// ============================================
// Helpers
// ============================================

function formatTime(isoString: string): { display: string; relative: string } {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  const timeStr = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateStr = date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  let relative: string;
  if (diffMs < 0) {
    const agoMins = Math.abs(diffMins);
    if (agoMins < 60) {
      relative = `Started ${agoMins}m ago`;
    } else {
      relative = `Started ${Math.floor(agoMins / 60)}h ago`;
    }
  } else if (diffMins < 60) {
    relative = `In ${diffMins}m`;
  } else if (diffMins < 1440) {
    relative = `In ${Math.floor(diffMins / 60)}h ${diffMins % 60}m`;
  } else {
    relative = `In ${Math.floor(diffMins / 1440)}d`;
  }

  return { display: `${dateStr} ${timeStr}`, relative };
}

function formatOddsAge(timestamp: number): {
  display: string;
  isFresh: boolean;
} {
  const ageMs = Date.now() - timestamp;
  const ageSec = Math.floor(ageMs / 1000);

  if (ageSec < 60) {
    return { display: `${ageSec}s ago`, isFresh: ageSec < 90 };
  } else if (ageSec < 3600) {
    return { display: `${Math.floor(ageSec / 60)}m ago`, isFresh: false };
  } else {
    return { display: `${Math.floor(ageSec / 3600)}h ago`, isFresh: false };
  }
}

function pct(value: number, decimals = 2): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

function roundStake(stake: number): number {
  if (stake <= 0) return 0;
  if (stake < 10) {
    return Math.round(stake);
  } else if (stake < 50) {
    return Math.round(stake / 5) * 5;
  } else {
    return Math.round(stake / 10) * 10;
  }
}

interface MarketLimits {
  minBet: number;
  maxBet: number | null;
  balance: number;
  currency: string;
  source: "market" | "account";
  suspended: boolean;
}

interface ValueMetrics {
  odds: number; // Raw odds from provider
  adjustedOdds: number; // Commission-adjusted odds
  commissionPct: number; // Commission percentage applied
  impliedProb: number;
  evPct: number;
  kellyFull: number;
  kellyFraction: number;
  kellyStake: number;
  suggested: number;
  hasValue: boolean;
}

/**
 * @param bankrollBdt  Real account balance in BDT. When supplied AND
 *                     the operator has `useLiveBalance` on, Kelly stake
 *                     is sized against it; otherwise we use the stored
 *                     `manualBankrollBdt` setting.
 * @param marketMinBdt Per-market minimum stake. Used only to clamp the
 *                     `suggested` stake up to a placeable amount.
 * @param settings     Betting settings from /api/betting-settings. When
 *                     omitted (pre-hydration) we fall back to the old
 *                     quarter-Kelly + 1000-BDT-bankroll defaults so the
 *                     initial render still shows a sensible number.
 *
 * The `suggested` value always lands on a multiple of `stakeBucketBdt`
 * and is no lower than `max(marketMin, settings.minStakeBdt)`.
 */
function calculateValueMetrics(
  softOdds: number,
  trueProb: number,
  commissionPct: number = 0,
  bankrollBdt?: number,
  marketMinBdt?: number,
  settings?: BettingSettingsClient | null,
): ValueMetrics {
  if (softOdds <= 1 || trueProb <= 0 || trueProb >= 1) {
    return {
      odds: softOdds,
      adjustedOdds: softOdds,
      commissionPct,
      impliedProb: 0,
      evPct: 0,
      kellyFull: 0,
      kellyFraction: 0,
      kellyStake: 0,
      suggested: 0,
      hasValue: false,
    };
  }

  // Calculate commission-adjusted odds
  const adjustedOdds = adjustOddsForCommission(softOdds, commissionPct);

  // Use adjusted odds for all calculations
  const impliedProb = 1 / adjustedOdds;
  const ev = adjustedOdds * trueProb - 1;
  const evPct = ev * 100;
  const kellyFull = ev / (adjustedOdds - 1);

  // Resolve effective bankroll from settings. Live balance is used when
  // the operator has opted in AND the provider returned one; otherwise
  // the stored manual bankroll; otherwise the legacy 1000 default.
  const liveBankroll =
    typeof bankrollBdt === "number" && bankrollBdt > 0 ? bankrollBdt : null;
  const bankroll = settings
    ? settings.useLiveBalance && liveBankroll != null
      ? liveBankroll
      : settings.manualBankrollBdt
    : (liveBankroll ?? VALUE_TOTAL_STAKE);

  const rawStake = settings
    ? computeStake({
        fullKelly: kellyFull,
        bankrollBdt: bankroll,
        kellyCapPct: settings.kellyCapPct,
        kellyFraction: settings.kellyFraction ?? KELLY_FRACTION,
      })
    : bankroll * Math.max(0, kellyFull * KELLY_FRACTION);

  const kellyStake = rawStake;

  // Snap to the operator's stake bucket, then clamp up to the greater
  // of (market min, settings floor). Same rule the backend placer uses.
  const bucket = settings?.stakeBucketBdt ?? 1;
  const floor = Math.max(
    settings?.minStakeBdt ?? UI_MIN_STAKE_FLOOR,
    marketMinBdt ?? 0,
  );
  let suggested =
    bucket > 0 ? Math.floor(rawStake / bucket) * bucket : rawStake;
  if (suggested < floor) {
    suggested = bucket > 0 ? Math.ceil(floor / bucket) * bucket : floor;
  }
  // Legacy: when settings aren't loaded yet AND no market min was
  // passed, keep the old raw-Kelly-rounded behavior — downstream code
  // re-clamps once limits load.
  if (!settings && typeof marketMinBdt !== "number") {
    suggested = roundStake(rawStake);
  }

  // For consumers of `kellyFraction` (displayed in the UI as
  // "Kelly stake %"), keep it as the effective fraction of bankroll
  // actually recommended. Strategy-aware: equals stake/bankroll.
  const kellyFractionVal = bankroll > 0 ? Math.max(0, rawStake / bankroll) : 0;

  return {
    odds: softOdds,
    adjustedOdds,
    commissionPct,
    impliedProb,
    evPct,
    kellyFull: kellyFull * 100,
    kellyFraction: kellyFractionVal * 100,
    kellyStake,
    suggested,
    hasValue: evPct > 0,
  };
}

// ============================================
// Component
// ============================================

export function ValueBetDetailsModal({
  open,
  onOpenChange,
  eventLabel,
  competition,
  startTime,
  marketLabel,
  outcomeLabel,
  details,
  atomOdds,
  eventId,
  providerEventIds: _providerEventIds,
  liveScore,
  placementContext,
}: ValueBetDetailsModalProps) {
  // Selected provider (or "custom")
  const [selected, setSelected] = useState<Selection | null>(
    details?.softProvider ?? null,
  );
  const [customOdds, setCustomOdds] = useState<string>("");
  const [customCommission, setCustomCommission] = useState<string>("");
  // Manual-placement state. Defaults to the Kelly recommendation for the
  // currently selected provider and resets whenever the selection
  // changes. The operator can override before hitting "Place Bet".
  const [placeStake, setPlaceStake] = useState<string>("");
  const [placing, setPlacing] = useState(false);
  const [placeResult, setPlaceResult] = useState<
    | {
        status: "placed" | "pending";
        placedBetId: string;
        bookedOdds: number;
        stake: number;
        ticketId?: string;
      }
    | { status: "skipped" | "rejected" | "error"; reason: string }
    | null
  >(null);

  // Book-imposed stake window + account balance for the currently
  // selected provider. Lifted from PlaceBetPanel so the parent's
  // value-metrics useMemo can size Kelly against a real BDT bankroll
  // and apply the market-min clamp rule. Re-fetched on an interval so
  // books that raise mins mid-session (e.g. pre-match → in-play) are
  // reflected without the operator closing and reopening the modal.
  const [limits, setLimits] = useState<MarketLimits | null>(null);
  const [limitsLoading, setLimitsLoading] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  // Operator-chosen strategy + bankroll rules. Drives the Suggested
  // stake column; mirrors the backend placer exactly.
  const { settings: bettingSettings } = useBettingSettings();

  const selectedProvider =
    selected && selected !== "custom" ? (selected as ProviderKey) : null;

  useEffect(() => {
    if (
      !eventId ||
      !placementContext ||
      !selectedProvider ||
      !CONFIGURED_BETTING_PROVIDER_IDS.includes(selectedProvider as string)
    ) {
      setLimits(null);
      setLimitsError(null);
      return;
    }
    let cancelled = false;
    const run = () => {
      setLimitsLoading(true);
      setLimitsError(null);
      fetch("/api/bets/market-limits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          softProvider: selectedProvider,
          eventId,
          atomId: placementContext.atomId,
        }),
      })
        .then(async (res) => {
          const body = await res.json();
          if (cancelled) return;
          if (!res.ok) {
            setLimitsError(body?.error ?? `HTTP ${res.status}`);
          } else {
            setLimits(body as MarketLimits);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setLimitsError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLimitsLoading(false);
        });
    };
    run();
    const id = window.setInterval(run, LIMITS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [eventId, selectedProvider, placementContext]);

  // Wall-clock tick so the "In Xm" / "Started Ym ago" / odds-age
  // displays keep moving while the modal is open. Without this, both
  // memos freeze at their inputs and a modal left open for hours shows
  // stale times.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [open]);

  const timeInfo = useMemo(
    () => formatTime(startTime),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startTime, now],
  );
  const oddsAge = useMemo(
    () => (details ? formatOddsAge(details.timestamp) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [details, now],
  );

  // Get effective commission (custom override or provider default)
  const getEffectiveCommission = useCallback(
    (provider: ProviderKey): number => {
      // If custom commission is set, use it for all providers
      if (customCommission && !isNaN(parseFloat(customCommission))) {
        return parseFloat(customCommission);
      }
      // Otherwise use provider's default commission
      return getProviderCommission(provider);
    },
    [customCommission],
  );

  // Calculate value for all soft providers
  const providerValues = useMemo(() => {
    if (!details || !atomOdds) return [];

    const softProviders = getSoftProviders();
    const values: {
      provider: ProviderKey;
      odds: number;
      timestamp: number;
      metrics: ValueMetrics;
      isBest: boolean;
      isPlaceable: boolean;
    }[] = [];

    for (const provider of softProviders) {
      const oddsData = atomOdds[provider];
      if (!oddsData || oddsData.suspended) continue;

      // Get commission for this provider (custom or default)
      const commission = getEffectiveCommission(provider);
      // Only use the fetched bankroll/min when the limits snapshot is
      // for THIS provider — otherwise 9W-Ex's balance would be sized
      // against 9W-SB's numbers and vice versa.
      const useLimits = limits && provider === selectedProvider;
      const metrics = calculateValueMetrics(
        oddsData.value,
        details.trueProb,
        commission,
        useLimits ? limits!.balance : undefined,
        useLimits ? limits!.minBet : undefined,
        bettingSettings,
      );
      values.push({
        provider,
        odds: oddsData.value,
        timestamp: oddsData.timestamp,
        metrics,
        isBest: provider === details.softProvider,
        isPlaceable: CONFIGURED_BETTING_PROVIDER_IDS.includes(provider),
      });
    }

    return values.sort((a, b) => b.metrics.evPct - a.metrics.evPct);
  }, [
    details,
    atomOdds,
    getEffectiveCommission,
    limits,
    selectedProvider,
    bettingSettings,
  ]);

  // Custom odds metrics
  const customMetrics = useMemo(() => {
    const oddsNum = parseFloat(customOdds);
    if (!details || isNaN(oddsNum) || oddsNum <= 1) return null;
    // Use custom commission if set, otherwise 0 for custom odds
    const commission = customCommission ? parseFloat(customCommission) : 0;
    return calculateValueMetrics(
      oddsNum,
      details.trueProb,
      isNaN(commission) ? 0 : commission,
      limits?.balance,
      limits?.minBet,
      bettingSettings,
    );
  }, [customOdds, details, customCommission, limits, bettingSettings]);

  // Get metrics for currently selected provider/custom
  const selectedMetrics = useMemo((): {
    label: string;
    metrics: ValueMetrics;
  } | null => {
    if (!details) return null;

    if (selected === "custom") {
      if (customMetrics) {
        return { label: "Custom", metrics: customMetrics };
      }
      return null;
    }

    const pv = providerValues.find((p) => p.provider === selected);
    if (pv) {
      return { label: getProviderShortName(pv.provider), metrics: pv.metrics };
    }

    // Fallback to best provider
    const best = providerValues.find((p) => p.isBest);
    if (best) {
      return {
        label: getProviderShortName(best.provider),
        metrics: best.metrics,
      };
    }

    return null;
  }, [selected, details, providerValues, customMetrics]);

  const liveStatusLine = liveScore
    ? `Live: ${liveScore.home}-${liveScore.away} ${liveScore.minute}' ${liveScore.period}${
        liveScore.homeRedCards > 0 || liveScore.awayRedCards > 0
          ? ` | Red cards: ${liveScore.homeRedCards}-${liveScore.awayRedCards}`
          : ""
      }`
    : null;

  // Copy functions
  const handleCopyAll = () => {
    if (!details || !selectedMetrics) return;

    const familySection = details.familyOdds
      ? `
FAMILY ODDS (${getProviderShortName(details.sharpProvider)})
${"─".repeat(50)}
${details.familyOdds.atoms
  .map((a) => {
    const isAtomSelected = a.label.toLowerCase() === outcomeLabel.toLowerCase();
    return `${a.label.padEnd(20)} ${a.rawOdds.toFixed(3).padStart(8)}   ${pct(a.trueProb).padStart(8)}${isAtomSelected ? "  ← selected" : ""}`;
  })
  .join("\n")}
${"─".repeat(50)}
Vig: ${details.familyOdds.vigPct.toFixed(2)}%
`
      : "";

    const providerSection =
      providerValues.length > 0
        ? `
VALUE OPPORTUNITIES
${"─".repeat(50)}
${providerValues
  .map((pv) => {
    const marker = pv.provider === selected ? " ←" : "";
    return `${getProviderShortName(pv.provider).padEnd(12)} ${pv.odds.toFixed(3).padStart(8)}   ${pv.metrics.hasValue ? "+" : ""}${pv.metrics.evPct.toFixed(2)}%   ${pv.metrics.suggested} ${DISPLAY_CURRENCY}${marker}`;
  })
  .join("\n")}
${customMetrics ? `${"Custom".padEnd(12)} ${customMetrics.odds.toFixed(3).padStart(8)}   ${customMetrics.hasValue ? "+" : ""}${customMetrics.evPct.toFixed(2)}%   ${customMetrics.suggested} ${DISPLAY_CURRENCY}${selected === "custom" ? " ←" : ""}` : ""}
`
        : "";

    const m = selectedMetrics.metrics;
    const text = `
VALUE BET DETAILS
${"═".repeat(50)}
Event: ${eventLabel}
Competition: ${competition}
Kickoff: ${timeInfo.display} (${timeInfo.relative})
${liveStatusLine ? `${liveStatusLine}\n` : ""}

SELECTED BET
${"─".repeat(50)}
${marketLabel} → ${outcomeLabel}
Sharp (${getProviderShortName(details.sharpProvider)}): ${details.sharpOdds.toFixed(3)}   True Prob: ${pct(details.trueProb)}

BET AT: ${selectedMetrics.label}
Odds: ${m.odds.toFixed(2)}
EV: ${m.hasValue ? "+" : ""}${m.evPct.toFixed(2)}%
Stake: ${m.suggested} ${DISPLAY_CURRENCY} (exact Kelly: ${m.kellyStake.toFixed(2)} ${DISPLAY_CURRENCY})
${providerSection}${familySection}
Odds Age: ${oddsAge?.display || "unknown"}
`.trim();

    navigator.clipboard.writeText(text);
    toast.success("📋 Copied", {
      description: "Full value bet details",
    });
  };

  const handleCopyBet = () => {
    if (!details || !selectedMetrics) return;

    const m = selectedMetrics.metrics;
    const text = `${eventLabel}
${liveStatusLine ? `${liveStatusLine}\n` : ""}${marketLabel} → ${outcomeLabel}
Bet @ ${selectedMetrics.label}: ${m.odds.toFixed(2)}
EV: ${m.hasValue ? "+" : ""}${m.evPct.toFixed(2)}%  |  Stake: ${m.suggested} ${DISPLAY_CURRENCY}`;

    navigator.clipboard.writeText(text);
    toast.success("📋 Copied", {
      description: `${outcomeLabel} @ ${selectedMetrics.label}`,
    });
  };

  if (!details) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-4xl max-h-[92vh] overflow-y-auto gap-2">
        {/* Header */}
        <DialogHeader className="pb-2 border-b border-border/50">
          <DialogTitle className="text-base font-semibold">
            Value Bet Details
          </DialogTitle>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-medium text-foreground">{eventLabel}</span>
            <span className="text-muted-foreground">•</span>
            <span className="text-muted-foreground">{competition}</span>
            <span className="text-muted-foreground">•</span>
            <Badge variant="outline" className="text-xs">
              {timeInfo.relative}
            </Badge>
          </div>
          {liveScore && (
            <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
              <Badge variant="destructive" className="text-[10px] uppercase">
                Live
              </Badge>
              <span className="font-mono font-semibold text-yellow-500">
                {liveScore.home}-{liveScore.away}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {liveScore.minute}&apos; {liveScore.period}
              </Badge>
              {(liveScore.homeRedCards > 0 || liveScore.awayRedCards > 0) && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-red-500 border-red-500/50"
                >
                  {liveScore.homeRedCards + liveScore.awayRedCards} red
                </Badge>
              )}
              {liveScore.hasDiscrepancy && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-yellow-500 border-yellow-500/50"
                  title="Providers disagree on the current score"
                >
                  Score mismatch
                </Badge>
              )}
              {liveScore.primarySource && (
                <Badge variant="outline" className="text-[10px]">
                  {liveScore.primarySource === "pinnacle"
                    ? "Source: Pinnacle"
                    : "Source: BC"}
                </Badge>
              )}
            </div>
          )}
        </DialogHeader>

        {/* Selected Bet - Compact Horizontal */}
        <div className="rounded-lg border-2 border-cyan-500/50 bg-cyan-500/5 p-3">
          <div className="flex items-center justify-between gap-4">
            {/* Left: Market + Outcome */}
            <div className="flex items-center gap-2 min-w-0">
              <TrendingUp className="size-4 text-cyan-500 shrink-0" />
              <span className="text-sm text-muted-foreground truncate">
                {marketLabel}
              </span>
              <ArrowRight className="size-3 shrink-0" />
              <Badge className="bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300 font-medium shrink-0">
                {outcomeLabel}
              </Badge>
            </div>

            {/* Right: Key Numbers + Refresh */}
            <div className="flex items-center gap-3 text-sm shrink-0">
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">
                  {getProviderShortName(details.sharpProvider)}
                </div>
                <div className="font-mono font-medium">
                  {details.sharpOdds.toFixed(3)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-muted-foreground">
                  True Prob
                </div>
                <div className="font-mono font-medium text-blue-500">
                  {pct(details.trueProb)}
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground border-l pl-3">
                <Clock className="size-3" />
                <span>{oddsAge?.display}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Two Column Layout — Calculation merged into PlaceBetPanel "Details" disclosure */}
        <div className="flex gap-2 items-stretch">
          {/* Left: Family Odds */}
          {details.familyOdds && (
            <div className="flex-1 rounded-lg border border-border bg-muted/30 p-2">
              <div className="text-sm font-medium mb-2 flex items-center justify-between">
                <span>Family Odds</span>
                <span className="text-[10px] text-muted-foreground font-normal">
                  {getProviderShortName(details.sharpProvider)}
                </span>
              </div>

              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[10px] text-muted-foreground border-b border-border/50">
                    <th className="text-left pb-1.5 font-medium">Outcome</th>
                    <th className="text-right pb-1.5 font-medium">Odds</th>
                    <th className="text-right pb-1.5 font-medium">True</th>
                  </tr>
                </thead>
                <tbody>
                  {details.familyOdds.atoms.map((atom) => {
                    const isAtomSelected =
                      atom.label.toLowerCase() === outcomeLabel.toLowerCase();
                    return (
                      <tr
                        key={atom.atomId}
                        className={
                          isAtomSelected ? "bg-cyan-500/10 font-medium" : ""
                        }
                      >
                        <td className="py-1 flex items-center gap-1">
                          {atom.label}
                          {isAtomSelected && (
                            <span className="text-[10px] text-cyan-500">←</span>
                          )}
                        </td>
                        <td className="text-right py-1 font-mono">
                          {atom.rawOdds.toFixed(3)}
                        </td>
                        <td className="text-right py-1 font-mono text-blue-500">
                          {pct(atom.trueProb, 1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="border-t border-border/50">
                  <tr className="text-[10px] text-muted-foreground">
                    <td className="pt-1.5">Vig:</td>
                    <td
                      className="pt-1.5 text-right text-orange-500 font-mono"
                      colSpan={2}
                    >
                      {details.familyOdds.vigPct.toFixed(1)}%
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* Right: Value Opportunities - CLICKABLE ROWS */}
          <div className="flex-1 rounded-lg border border-border bg-muted/30 p-2">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-sm font-medium">Value Opportunities</div>
                <div className="text-[10px] text-muted-foreground">
                  Click to select
                </div>
              </div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    title="Commission override"
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-64 p-3 space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Commission Override
                  </div>
                  <div className="text-[10px] text-muted-foreground leading-snug">
                    Overrides the provider&apos;s default commission used to
                    adjust odds before EV.
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="20"
                      placeholder={
                        selected && selected !== "custom"
                          ? `${getProviderCommission(selected)}`
                          : "0"
                      }
                      value={customCommission}
                      onChange={(e) => setCustomCommission(e.target.value)}
                      className="h-8 flex-1 text-xs font-mono text-right px-2 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-orange-500/50"
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                    {customCommission && (
                      <button
                        onClick={() => setCustomCommission("")}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                        title="Reset to provider default"
                      >
                        reset
                      </button>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1">
              {providerValues.map((pv) => {
                const isSelected = selected === pv.provider;
                return (
                  <div
                    key={pv.provider}
                    onClick={() => setSelected(pv.provider)}
                    className={`flex items-center justify-between px-2 py-1.5 rounded cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-cyan-500/20 border border-cyan-500/50"
                        : "hover:bg-muted/50 border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-xs ${isSelected ? "font-medium" : ""}`}
                      >
                        {getProviderShortName(pv.provider)}
                      </span>
                      {pv.isBest && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 h-4"
                        >
                          Best
                        </Badge>
                      )}
                      {pv.metrics.commissionPct > 0 && (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1 py-0 h-4 text-orange-500 border-orange-500/50"
                        >
                          {pv.metrics.commissionPct}%
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="font-mono w-14 text-right">
                        {pv.odds.toFixed(3)}
                      </span>
                      <span
                        className={`font-mono w-16 text-right font-bold ${
                          pv.metrics.evPct > 0
                            ? "text-cyan-500"
                            : pv.metrics.evPct < 0
                              ? "text-amber-500"
                              : "text-muted-foreground"
                        }`}
                      >
                        {pv.metrics.evPct > 0 ? "+" : ""}
                        {pv.metrics.evPct.toFixed(2)}%
                      </span>
                      <span
                        className={`font-mono w-16 text-right ${pv.metrics.hasValue ? "text-amber-500" : "text-muted-foreground"}`}
                      >
                        {pv.metrics.suggested} {DISPLAY_CURRENCY}
                      </span>
                    </div>
                  </div>
                );
              })}

              {providerValues.length === 0 && (
                <div className="py-2 text-center text-xs text-muted-foreground">
                  No soft provider odds available
                </div>
              )}

              {/* Custom Odds Row */}
              <div className="border-t border-border/30 mt-2 pt-2">
                <div
                  onClick={() => setSelected("custom")}
                  className={`flex items-center justify-between gap-4 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    selected === "custom"
                      ? "bg-cyan-500/20 border border-cyan-500/50"
                      : "hover:bg-muted/50 border border-transparent"
                  }`}
                >
                  <span
                    className={`text-xs shrink-0 ${selected === "custom" ? "font-medium" : "text-muted-foreground"}`}
                  >
                    Custom
                  </span>
                  <div className="flex items-center gap-3 text-xs">
                    <input
                      type="number"
                      step="0.01"
                      min="1.01"
                      placeholder="Odds"
                      value={customOdds}
                      onChange={(e) => {
                        setCustomOdds(e.target.value);
                        setSelected("custom");
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-6 w-20 text-xs font-mono text-right px-1.5 bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    />
                    <span
                      className={`font-mono w-16 text-right font-bold ${
                        customMetrics && customMetrics.evPct > 0
                          ? "text-cyan-500"
                          : customMetrics && customMetrics.evPct < 0
                            ? "text-amber-500"
                            : "text-muted-foreground"
                      }`}
                    >
                      {customMetrics
                        ? `${customMetrics.evPct > 0 ? "+" : ""}${customMetrics.evPct.toFixed(2)}%`
                        : "—"}
                    </span>
                    <span
                      className={`font-mono w-10 text-right ${customMetrics?.hasValue ? "text-amber-500" : "text-muted-foreground"}`}
                    >
                      {customMetrics
                        ? `${customMetrics.suggested} ${DISPLAY_CURRENCY}`
                        : "—"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Place Bet panel — opt-in, only rendered when the parent supplies
            enough context to build a runtime descriptor (familyId, atomId,
            teams, kickoff). Uses the currently selected provider/odds to
            compute the default Kelly stake; operator can override.
            Hidden when the selected provider has no registered betting adapter. */}
        {placementContext && details && selectedMetrics && (
          <PlaceBetPanel
            details={details}
            placementContext={placementContext}
            eventId={eventId}
            marketLabel={marketLabel}
            outcomeLabel={outcomeLabel}
            selected={selected}
            selectedMetrics={selectedMetrics}
            providerValues={providerValues}
            customOdds={customOdds}
            customCommission={customCommission}
            stake={placeStake}
            setStake={setPlaceStake}
            placing={placing}
            setPlacing={setPlacing}
            onClose={() => onOpenChange(false)}
            result={placeResult}
            setResult={setPlaceResult}
            limits={limits}
            limitsLoading={limitsLoading}
            limitsError={limitsError}
          />
        )}

        {/* Footer */}
        <DialogFooter className="pt-2 border-t border-border/50 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyAll}
            disabled={!selectedMetrics}
          >
            <Copy className="size-3.5 mr-1.5" />
            Copy All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyBet}
            disabled={!selectedMetrics}
          >
            <Copy className="size-3.5 mr-1.5" />
            Copy Bet
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
