"use client";

import { useEffect, useRef, useState } from "react";
import {
  Zap,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Target,
  CornerDownLeft,
} from "lucide-react";
import { LoadingButton } from "@/components/ui/loading-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { getProviderShortName } from "@/lib/providers/registry";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "@/lib/betting/configured-ids";
import { KELLY_FRACTION } from "@/lib/shared/constants";
import { useBettingSettings } from "@/hooks/use-betting-settings";
import type {
  ValueBetDetails,
  PlacementContext,
} from "../spreadsheet/ValueBetDetailsModal";
import type { ProviderKey } from "@/lib/providers/registry";

const DISPLAY_CURRENCY = "BDT";
const UI_MIN_STAKE_FLOOR = 119;
// Balance threshold above which we paint the header balance green.
// Under this, the balance is technically usable but thin enough that
// we keep the color neutral (not a red warning — only over-balance
// stakes paint red).
const BALANCE_HEALTHY_THRESHOLD = 2000;

interface MarketLimits {
  minBet: number;
  maxBet: number | null;
  balance: number;
  currency: string;
  source: "market" | "account";
  suspended: boolean;
}

interface ValueMetrics {
  odds: number;
  adjustedOdds: number;
  commissionPct: number;
  impliedProb: number;
  evPct: number;
  kellyFull: number;
  kellyFraction: number;
  kellyStake: number;
  suggested: number;
  hasValue: boolean;
}

interface PlaceBetPanelProps {
  details: ValueBetDetails;
  placementContext: PlacementContext;
  eventId?: string;
  marketLabel?: string;
  outcomeLabel?: string;
  selected: ProviderKey | "custom" | null;
  selectedMetrics: { label: string; metrics: ValueMetrics };
  providerValues: {
    provider: ProviderKey;
    odds: number;
    timestamp: number;
    metrics: ValueMetrics;
    isBest: boolean;
    isPlaceable: boolean;
  }[];
  customOdds: string;
  customCommission: string;
  stake: string;
  setStake: (v: string) => void;
  placing: boolean;
  setPlacing: (v: boolean) => void;
  result:
    | {
        status: "placed" | "pending";
        placedBetId: string;
        bookedOdds: number;
        stake: number;
        ticketId?: string;
      }
    | { status: "skipped" | "rejected" | "error"; reason: string }
    | null;
  setResult: (v: PlaceBetPanelProps["result"]) => void;
  limits: MarketLimits | null;
  limitsLoading: boolean;
  limitsError: string | null;
  onClose?: () => void;
}

type EvTone = "positive" | "zero" | "negative";

function classifyEv(evPct: number): EvTone {
  if (evPct > 0.001) return "positive";
  if (evPct < -0.001) return "negative";
  return "zero";
}

export function PlaceBetPanel({
  details,
  placementContext,
  eventId,
  marketLabel,
  outcomeLabel,
  selected,
  selectedMetrics,
  providerValues,
  customOdds,
  customCommission,
  stake,
  setStake,
  placing,
  setPlacing,
  result,
  setResult,
  limits,
  limitsLoading,
  limitsError,
  onClose,
}: PlaceBetPanelProps) {
  const chosenProvider =
    selected && selected !== "custom" ? (selected as ProviderKey) : null;
  const chosenOdds =
    chosenProvider !== null
      ? providerValues.find((p) => p.provider === chosenProvider)?.odds
      : null;
  // Operator-chosen min-stake floor overrides the hardcoded UI baseline
  // when available. Keeps the panel's "Stake below UI floor" warning
  // consistent with what the backend placer actually enforces.
  const { settings: bettingSettings } = useBettingSettings();
  const floorStake = bettingSettings?.minStakeBdt ?? UI_MIN_STAKE_FLOOR;
  const strategyLabel = `kelly-${KELLY_FRACTION}`;

  const kellySuggested = selectedMetrics.metrics.suggested;
  useEffect(() => {
    if (kellySuggested > 0) {
      setStake(String(kellySuggested));
      return;
    }
    // Seed with the UI floor so the Place button isn't disabled while
    // /market-limits is in flight. If the market min turns out to be
    // higher, the backend placer will catch it — the frontend doesn't
    // gate on it anymore (belowMarketMin is a warning, not a block).
    if (limits) {
      setStake(String(Math.max(limits.minBet, floorStake)));
    } else {
      setStake(String(floorStake));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selected,
    customOdds,
    customCommission,
    kellySuggested,
    limits?.minBet,
    floorStake,
  ]);

  const [confirmNonValue, setConfirmNonValue] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [mode, setMode] = useState<"risk" | "win">("risk");
  const stakeInputRef = useRef<HTMLInputElement>(null);

  const evTone = classifyEv(selectedMetrics.metrics.evPct);
  const isNegativeEv = evTone === "negative";

  useEffect(() => {
    setConfirmNonValue(false);
  }, [selected, customOdds, customCommission]);

  // --- Stake derived from mode (Risk = amount to stake, Win = target profit)
  // The underlying `stake` state is always the stake in BDT (risk amount).
  // When mode === "win", the input reflects target profit and we convert
  // back to stake internally.
  const stakeNum = Number(stake);
  const stakeValidNumber = Number.isFinite(stakeNum) && stakeNum > 0;

  const targetWin =
    stakeValidNumber && chosenOdds != null ? stakeNum * (chosenOdds - 1) : 0;

  const inputValue =
    mode === "risk"
      ? stake
      : stakeValidNumber && chosenOdds != null && chosenOdds > 1
        ? String(Math.round(targetWin))
        : "";

  const handleInputChange = (v: string) => {
    if (mode === "risk") {
      setStake(v);
      return;
    }
    const winNum = Number(v);
    if (!Number.isFinite(winNum) || winNum <= 0 || chosenOdds == null) {
      setStake(v);
      return;
    }
    const derivedStake = winNum / (chosenOdds - 1);
    setStake(String(Math.max(0, Math.round(derivedStake))));
  };

  const belowFloor = stakeValidNumber && stakeNum < floorStake;
  // `belowMarketMin` is informational — the operator-set UI floor (119)
  // is the real provider minimum; the book's reported minBet is often
  // 1 BDT which is misleading. Shown as a hint, never blocks placement.
  const belowMarketMin =
    !!limits && stakeValidNumber && stakeNum < limits.minBet;
  const aboveMarketMax =
    !!limits && limits.maxBet != null && stakeNum > limits.maxBet;
  const aboveBalance = !!limits && stakeNum > limits.balance;
  const stakeValid =
    stakeValidNumber && !belowFloor && !aboveMarketMax && !aboveBalance;

  const providerConfigured =
    selected !== null &&
    selected !== "custom" &&
    CONFIGURED_BETTING_PROVIDER_IDS.includes(selected as string);

  const suspended = !!limits?.suspended;

  // EV-zero does NOT require confirmation — only truly negative EV does.
  const needsEvOverride = isNegativeEv;
  const canPlace =
    !placing &&
    !!eventId &&
    providerConfigured &&
    (!needsEvOverride || confirmNonValue) &&
    stakeValid &&
    !suspended;

  const providerShort = chosenProvider
    ? getProviderShortName(chosenProvider)
    : "—";

  const isFailureResult = (
    r: PlaceBetPanelProps["result"],
  ): r is { status: "skipped" | "rejected" | "error"; reason: string } => {
    return (
      r !== null &&
      (r.status === "skipped" ||
        r.status === "rejected" ||
        r.status === "error")
    );
  };

  async function handlePlace() {
    if (!eventId || !chosenProvider || chosenOdds == null) return;
    setPlacing(true);
    setResult(null);
    try {
      const res = await fetch("/api/bets/place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kellyStake: Number(stake),
          runtime: {
            eventId,
            familyId: placementContext.familyId,
            atomId: placementContext.atomId,
            atomLabel: placementContext.atomLabel,
            homeTeam: placementContext.homeTeam,
            awayTeam: placementContext.awayTeam,
            competition: placementContext.competition ?? null,
            eventStartTime: placementContext.eventStartTime,
            marketType: placementContext.marketType,
            softProvider: chosenProvider,
            softOdds: chosenOdds,
            sharpProvider: details.sharpProvider,
            sharpOdds: details.sharpOdds,
            sharpTrueProb: details.trueProb,
            commissionPct: selectedMetrics.metrics.commissionPct,
          },
        }),
      });
      const body = (await res.json()) as PlaceBetPanelProps["result"];
      setResult(body);
      // Toast feedback — the in-panel banner covers the detail, but
      // toasts persist even if the modal is closed early.
      if (body?.status === "placed" || body?.status === "pending") {
        const label = outcomeLabel ? `${outcomeLabel} @ ${providerShort}` : providerShort;
        toast.success(`🎯 Bet ${body.status === "placed" ? "placed" : "pending"}`, {
          description: `${label} · ${Number(stake).toLocaleString()} ${DISPLAY_CURRENCY} @ ${chosenOdds!.toFixed(2)}`,
        });
      } else if (
        body &&
        (body.status === "skipped" ||
          body.status === "rejected" ||
          body.status === "error")
      ) {
        toast.error(`❌ Bet ${body.status}`, {
          description: body.reason?.slice(0, 150),
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setResult({ status: "error", reason: msg });
      toast.error("❌ Placement failed", { description: msg });
    } finally {
      setPlacing(false);
    }
  }

  const balance = limits?.balance ?? 0;

  // Balance color logic:
  //   - over-balance stake attempt  → red (error)
  //   - balance ≥ BALANCE_HEALTHY   → green (comfortable headroom)
  //   - otherwise (incl. unknown)   → neutral
  const balanceTone: "neutral" | "positive" | "negative" = !limits
    ? "neutral"
    : aboveBalance
      ? "negative"
      : limits.balance >= BALANCE_HEALTHY_THRESHOLD
        ? "positive"
        : "neutral";

  const adjustStake = (delta: number) => {
    const current = Number.isFinite(stakeNum) ? stakeNum : 0;
    const next = Math.max(0, Math.round(current + delta));
    setStake(String(next));
  };

  const potentialReturn =
    stakeValidNumber && chosenOdds != null ? stakeNum * chosenOdds : 0;
  const potentialProfit = potentialReturn - (stakeValidNumber ? stakeNum : 0);

  // Validation message (priority-ordered)
  let validationMsg: string | null = null;
  if (!providerConfigured && selected !== null && selected !== "custom") {
    validationMsg = `${providerShort} is not configured for placement`;
  } else if (selected === "custom") {
    validationMsg = "Custom odds can't be placed — pick a book provider";
  } else if (selected === null) {
    validationMsg = "Select a provider to place a bet";
  } else if (suspended) {
    validationMsg = "Market is suspended";
  } else if (!stakeValidNumber) {
    validationMsg = "Enter a valid stake";
  } else if (belowFloor) {
    validationMsg = `Stake below min (${floorStake} ${DISPLAY_CURRENCY})`;
  } else if (aboveMarketMax && limits?.maxBet != null) {
    validationMsg = `Above market maximum (${limits.maxBet} ${DISPLAY_CURRENCY})`;
  } else if (aboveBalance) {
    validationMsg = `Exceeds balance (${balance.toLocaleString()} ${DISPLAY_CURRENCY})`;
  } else if (isNegativeEv && !confirmNonValue) {
    validationMsg = "Negative EV — confirm to override";
  }

  const disabledQuick = placing || !providerConfigured;

  // --- Keyboard shortcuts (scoped to this panel)
  // Enter → place; ↑/↓ → ±100; Shift+↑/↓ → ±1000
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;

      if (e.key === "Enter" && !e.shiftKey) {
        // Allow Enter both inside and outside the stake input to submit.
        if (
          target instanceof HTMLInputElement &&
          target !== stakeInputRef.current &&
          target.type !== "submit"
        ) {
          return;
        }
        if (canPlace && !placing) {
          e.preventDefault();
          handlePlace();
        }
        return;
      }

      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.metaKey &&
        !e.ctrlKey
      ) {
        // Only swallow arrows when the stake input is focused — otherwise
        // we'd break dialog scrolling.
        if (target !== stakeInputRef.current) return;
        e.preventDefault();
        const base = e.shiftKey ? 1000 : 100;
        adjustStake(e.key === "ArrowUp" ? base : -base);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPlace, placing, stakeNum]);

  // --- Edge label + tone ---
  const evLabel =
    evTone === "positive"
      ? `+${selectedMetrics.metrics.evPct.toFixed(2)}%`
      : evTone === "zero"
        ? "0.00%"
        : `${selectedMetrics.metrics.evPct.toFixed(2)}%`;

  const evHeaderTone: "positive" | "neutral" | "negative" =
    evTone === "positive"
      ? "positive"
      : evTone === "negative"
        ? "negative"
        : "neutral";

  // --- Success state replaces the form ---
  if (result?.status === "placed" || result?.status === "pending") {
    return (
      <SuccessPanel
        result={result}
        providerShort={providerShort}
        marketLabel={marketLabel}
        outcomeLabel={outcomeLabel}
        onDismiss={() => setResult(null)}
        onClose={onClose}
      />
    );
  }

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40">
        <Zap className="size-3.5 text-amber-500 shrink-0" />
        <div className="text-xs font-semibold shrink-0">Place Bet</div>
        {outcomeLabel && (
          <div
            className="flex items-center gap-1 shrink-0 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300 max-w-[160px]"
            title={
              marketLabel ? `${marketLabel} → ${outcomeLabel}` : outcomeLabel
            }
          >
            <Target className="size-2.5 shrink-0" />
            <span className="truncate">{outcomeLabel}</span>
          </div>
        )}

        {/* Status badges */}
        <div className="flex items-center justify-end gap-1.5 shrink-0 ml-auto">
          {limitsLoading && (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          )}
          {suspended ? (
            <span className="text-[9px] uppercase tracking-wider font-semibold text-rose-600 bg-rose-500/10 border border-rose-500/30 rounded px-1.5 py-0.5">
              Suspended
            </span>
          ) : !providerConfigured &&
            selected !== null &&
            selected !== "custom" ? (
            <span className="text-[9px] uppercase tracking-wider font-semibold text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
              Not Configured
            </span>
          ) : (
            <span className="invisible text-[9px] px-1.5 py-0.5">&nbsp;</span>
          )}
        </div>
      </div>

      {/* Metrics strip */}
      <div className="grid grid-cols-4 gap-px bg-border/50">
        <MetricCell label="Book" value={providerShort} />
        <MetricCell
          label="Odds"
          value={chosenOdds != null ? chosenOdds.toFixed(2) : "—"}
          mono
        />
        <MetricCell label="Edge" value={evLabel} tone={evHeaderTone} mono />
        <MetricCell
          label="Balance"
          value={
            limits
              ? `${limits.balance.toLocaleString()} ${DISPLAY_CURRENCY}`
              : "—"
          }
          tone={balanceTone}
          loading={limitsLoading && !limits}
          mono
        />
      </div>

      <div className="p-2.5 space-y-2">
        {/* Limits error */}
        {limitsError && (
          <div className="flex items-start gap-1.5 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[10px] text-rose-700 dark:text-rose-300">
            <AlertTriangle className="size-3 shrink-0 mt-0.5" />
            <span>Limits unavailable: {limitsError}</span>
          </div>
        )}

        {/* Stake input row */}
        <div className="flex items-center gap-1.5">
          {/* Risk / To-Win toggle */}
          <div
            className="flex shrink-0 rounded-md border border-border bg-muted/40 p-0.5 text-[10px] font-bold uppercase tracking-wider"
            role="group"
            aria-label="Stake mode"
          >
            <button
              type="button"
              onClick={() => setMode("risk")}
              disabled={placing}
              className={cn(
                "px-2 py-1 rounded-sm transition-colors",
                mode === "risk"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Risk
            </button>
            <button
              type="button"
              onClick={() => setMode("win")}
              disabled={placing || chosenOdds == null}
              className={cn(
                "px-2 py-1 rounded-sm transition-colors",
                mode === "win"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                chosenOdds == null && "opacity-50 cursor-not-allowed",
              )}
            >
              To Win
            </button>
          </div>

          <div className="relative flex-1">
            <Input
              ref={stakeInputRef}
              type="number"
              inputMode="decimal"
              step="1"
              min={limits?.minBet ?? 1}
              max={limits?.maxBet ?? undefined}
              value={inputValue}
              onChange={(e) => handleInputChange(e.target.value)}
              disabled={placing || !providerConfigured}
              aria-invalid={!!validationMsg && stakeValidNumber && !stakeValid}
              autoFocus
              className={cn(
                "h-9 pl-2.5 pr-12 font-mono text-sm font-semibold tabular-nums",
                stakeValidNumber &&
                  !stakeValid &&
                  "border-rose-500/60 focus-visible:ring-rose-500/30",
              )}
              placeholder={mode === "risk" ? "Stake" : "Target profit"}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
              {DISPLAY_CURRENCY}
            </span>
          </div>
        </div>

        {/* Book min/max hint — visible reference so the operator can
            see the provider's stake window without having to type a
            failing amount. Does NOT block placement; the real gate is
            the UI floor (119) + balance. */}
        <MarketLimitsHint
          limits={limits}
          limitsLoading={limitsLoading}
          floorStake={floorStake}
          belowMarketMin={belowMarketMin}
        />

        {/* Return meter bar — always rendered so the layout doesn't jump
            when the user clicks between providers (valid) and Custom/unset
            (no odds). Invalid states render a dimmed placeholder. */}
        <ReturnMeter
          stake={stakeValidNumber ? stakeNum : 0}
          profit={potentialProfit}
          total={potentialReturn}
          odds={chosenOdds ?? null}
          active={providerConfigured && stakeValidNumber && chosenOdds != null}
        />

        {/* Increment buttons */}
        <div className="grid grid-cols-5 gap-1">
          {STAKE_INCREMENTS.map((delta) => (
            <IncrementBtn
              key={delta}
              delta={delta}
              onClick={() => adjustStake(delta)}
              disabled={disabledQuick}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setStake("0")}
            disabled={disabledQuick}
            className="h-7 text-[10px] font-bold uppercase tracking-wider border-border/50 hover:border-rose-500/40 hover:bg-rose-500/5 hover:text-rose-600"
          >
            Clear
          </Button>
        </div>

        {/* Details disclosure — replaces the old Calculation panel */}
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {showDetails ? (
            <ChevronUp className="size-3" />
          ) : (
            <ChevronDown className="size-3" />
          )}
          Calculation details
        </button>

        {showDetails && (
          <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2 space-y-1 text-[11px]">
            {selectedMetrics.metrics.commissionPct > 0 && (
              <>
                <DetailRow
                  label="Raw odds"
                  value={selectedMetrics.metrics.odds.toFixed(3)}
                />
                <DetailRow
                  label="Commission"
                  value={`${selectedMetrics.metrics.commissionPct.toFixed(1)}%`}
                  tone="warn"
                />
                <DetailRow
                  label="Adj. odds"
                  value={selectedMetrics.metrics.adjustedOdds.toFixed(3)}
                />
              </>
            )}
            <DetailRow
              label="Implied prob"
              value={`${(selectedMetrics.metrics.impliedProb * 100).toFixed(2)}%`}
            />
            <DetailRow
              label="True prob"
              value={`${(details.trueProb * 100).toFixed(2)}%`}
            />
            <div className="h-px bg-border/50 my-1" />
            <DetailRow
              label="Kelly (full)"
              value={`${selectedMetrics.metrics.kellyFull.toFixed(2)}%`}
            />
            <DetailRow
              label={`Stake (${strategyLabel})`}
              value={`${selectedMetrics.metrics.kellyFraction.toFixed(2)}%`}
            />
            <DetailRow
              label="Kelly stake"
              value={`${selectedMetrics.metrics.kellyStake.toFixed(2)} ${DISPLAY_CURRENCY}`}
            />
            <DetailRow
              label="Suggested"
              value={`${selectedMetrics.metrics.suggested} ${DISPLAY_CURRENCY}`}
              tone="highlight"
            />
          </div>
        )}

        {/* Fixed-height alerts slot — reserves space so switching between
            positive/zero/negative EV (or clicking Custom) doesn't shift
            the Place button up and down. Exactly one row is rendered. */}
        <div className="min-h-[32px] flex items-stretch">
          {providerConfigured && isNegativeEv ? (
            <label className="flex items-center gap-2 w-full rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={confirmNonValue}
                onChange={(e) => setConfirmNonValue(e.target.checked)}
                disabled={placing}
                className="size-3.5 accent-amber-500 shrink-0"
              />
              <AlertTriangle className="size-3 text-amber-500 shrink-0" />
              <span className="text-[10px] text-amber-700 dark:text-amber-300 leading-tight truncate">
                <span className="font-semibold">Negative EV</span>
                <span className="opacity-80">
                  {" "}
                  ({selectedMetrics.metrics.evPct.toFixed(2)}%) — confirm to
                  override
                </span>
              </span>
            </label>
          ) : providerConfigured && evTone === "zero" ? (
            <div className="flex items-center gap-1.5 w-full rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-1 text-[10px] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="size-3 shrink-0" />
              <span className="truncate">
                <span className="font-semibold">No edge</span>
                <span className="opacity-80"> — this bet has 0.00% EV.</span>
              </span>
            </div>
          ) : validationMsg ? (
            <div className="flex items-center gap-1.5 w-full rounded border border-border/30 bg-muted/10 px-2.5 py-1 text-[10px] text-muted-foreground">
              <AlertTriangle className="size-3 text-amber-500 shrink-0" />
              <span className="truncate">{validationMsg}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 w-full rounded border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-[10px] text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-3 shrink-0" />
              <span className="truncate">Ready to place</span>
            </div>
          )}
        </div>

        {/* Place button with Enter hint */}
        <LoadingButton
          onClick={handlePlace}
          disabled={!canPlace}
          loading={placing}
          className={cn(
            "w-full h-10 text-sm font-bold tracking-wide uppercase gap-2",
            canPlace &&
              !placing &&
              "bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm shadow-emerald-900/20",
          )}
        >
          <span>
            {placing
              ? "Placing…"
              : providerConfigured && chosenOdds != null && stakeValidNumber
                ? `Place ${stakeNum.toLocaleString()} ${DISPLAY_CURRENCY} @ ${chosenOdds.toFixed(2)}`
                : "Place Bet"}
          </span>
          {canPlace && !placing && (
            <span className="inline-flex items-center gap-0.5 rounded border border-white/30 bg-white/10 px-1 py-0.5 text-[9px] font-semibold normal-case tracking-normal">
              <CornerDownLeft className="size-2.5" />
              Enter
            </span>
          )}
        </LoadingButton>

        {/* Failure result banner (success/pending replaces the whole panel above) */}
        {result && isFailureResult(result) && (
          <FailureBanner result={result} onDismiss={() => setResult(null)} />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

const STAKE_INCREMENTS = [100, 500, 1000, 5000] as const;

/**
 * Compact hint row showing the provider's reported stake window plus
 * our UI floor. Informational only — the Place button is gated by the
 * UI floor (`floorStake`), not by `limits.minBet`.
 */
function MarketLimitsHint({
  limits,
  limitsLoading,
  floorStake,
  belowMarketMin,
}: {
  limits: MarketLimits | null;
  limitsLoading: boolean;
  floorStake: number;
  belowMarketMin: boolean;
}) {
  if (limitsLoading && !limits) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        <span>Fetching book limits…</span>
      </div>
    );
  }
  if (!limits) return null;
  const maxText = limits.maxBet != null ? limits.maxBet.toLocaleString() : "—";
  return (
    <div className="flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums">
      <span className="text-muted-foreground">
        Book min{" "}
        <span
          className={cn(
            "font-semibold",
            belowMarketMin
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {limits.minBet.toLocaleString()}
        </span>{" "}
        <span className="opacity-60">· max</span>{" "}
        <span className="font-semibold text-foreground">{maxText}</span>
      </span>
      <span className="text-muted-foreground">
        UI floor{" "}
        <span className="font-semibold text-foreground">
          {floorStake.toLocaleString()}
        </span>
      </span>
    </div>
  );
}

function IncrementBtn({
  delta,
  onClick,
  disabled,
}: {
  delta: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  const label =
    delta >= 1000 ? `+${delta / 1000}K` : `+${delta.toLocaleString()}`;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="h-7 text-[10px] font-bold font-mono tabular-nums tracking-wider border-border/50 hover:border-foreground/30 hover:bg-muted/50"
    >
      {label}
    </Button>
  );
}

function MetricCell({
  label,
  value,
  tone = "neutral",
  loading = false,
  mono = false,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "negative";
  loading?: boolean;
  mono?: boolean;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-rose-600 dark:text-rose-400"
        : "text-foreground";

  return (
    <div className="flex flex-col items-center gap-0.5 bg-card px-2 py-1.5">
      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-4 w-14" />
      ) : (
        <span
          className={cn(
            "text-[13px] font-bold tabular-nums truncate",
            mono && "font-mono",
            toneClass,
          )}
        >
          {value}
        </span>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn" | "highlight";
}) {
  const toneClass =
    tone === "warn"
      ? "text-orange-500"
      : tone === "highlight"
        ? "text-amber-500 font-bold"
        : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", toneClass)}>{value}</span>
    </div>
  );
}

/**
 * Horizontal payout bar. The stake slice occupies `1/odds` of the width and
 * the profit slice takes the remainder. Gives an instant visual read of the
 * risk/reward ratio implied by the odds.
 *
 * Always rendered (even when `active` is false) so the containing panel's
 * height is stable across provider selection / invalid stake states. When
 * inactive, the bar shows a dimmed placeholder with em-dash numbers.
 */
function ReturnMeter({
  stake,
  profit,
  total,
  odds,
  active,
}: {
  stake: number;
  profit: number;
  total: number;
  odds: number | null;
  active: boolean;
}) {
  // Derive proportions. When the meter is inactive but we still have odds,
  // show the odds-implied split faintly so the user can see the payout
  // shape of the currently-selected market before typing a stake.
  let stakePct: number;
  if (active && total > 0 && stake > 0) {
    stakePct = (stake / total) * 100;
  } else if (odds != null && odds > 1) {
    stakePct = (1 / odds) * 100;
  } else {
    stakePct = 50;
  }
  stakePct = Math.max(1, Math.min(99, stakePct));
  const profitPct = 100 - stakePct;

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "flex h-6 overflow-hidden rounded-md border transition-opacity",
          active
            ? "border-border/60 opacity-100"
            : "border-border/30 opacity-40",
        )}
      >
        <div
          className={cn(
            "flex items-center justify-center text-[9px] font-bold uppercase tracking-wider",
            active
              ? "bg-muted-foreground/20 text-foreground/70"
              : "bg-muted-foreground/10 text-muted-foreground",
          )}
          style={{ width: `${stakePct}%` }}
          title={
            active
              ? `Stake: ${stake.toFixed(0)} ${DISPLAY_CURRENCY}`
              : undefined
          }
        >
          {stakePct >= 15 ? "STAKE" : ""}
        </div>
        <div
          className={cn(
            "flex items-center justify-center text-[9px] font-bold uppercase tracking-wider",
            active
              ? "bg-gradient-to-r from-emerald-600/90 to-emerald-500/80 text-white"
              : "bg-emerald-600/20 text-white/50",
          )}
          style={{ width: `${profitPct}%` }}
          title={
            active
              ? `Profit: ${profit.toFixed(0)} ${DISPLAY_CURRENCY}`
              : undefined
          }
        >
          {profitPct >= 15 ? "PROFIT" : ""}
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono tabular-nums">
        <span className="text-muted-foreground">
          Risk{" "}
          <span
            className={cn(
              "font-semibold",
              active ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {active ? stake.toLocaleString() : "—"}
          </span>
        </span>
        <span className="text-muted-foreground">
          Return{" "}
          <span
            className={cn(
              "font-semibold",
              active ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {active ? total.toFixed(0) : "—"}
          </span>
        </span>
        <span
          className={cn(
            "font-semibold",
            active
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-muted-foreground/60",
          )}
        >
          {active
            ? `+${profit.toFixed(0)} ${DISPLAY_CURRENCY}`
            : `— ${DISPLAY_CURRENCY}`}
        </span>
      </div>
    </div>
  );
}

function FailureBanner({
  result,
  onDismiss,
}: {
  result: { status: "skipped" | "rejected" | "error"; reason: string };
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
      <XCircle className="size-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="font-bold uppercase tracking-wider text-[10px]">
            {result.status}
          </div>
          <button
            onClick={onDismiss}
            className="text-[10px] font-semibold uppercase tracking-wider opacity-60 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
        <div className="mt-0.5 break-words">{result.reason}</div>
      </div>
    </div>
  );
}

// Poll cadence while the backend is still matching the bet on the
// provider side. Backend polls the book feed every 30s so a faster
// frontend cadence mostly reveals the DB transition (which is
// effectively instant once the book ticket surfaces).
const PENDING_POLL_MS = 3_000;
// How long to keep polling before giving up on the frontend side. The
// backend deadline is 2 min; add slack for clock drift + one final tick.
const PENDING_POLL_DEADLINE_MS = 3 * 60 * 1000;

type LivePlacementStatus = "placed" | "pending" | "timeout";

function SuccessPanel({
  result,
  providerShort,
  marketLabel,
  outcomeLabel,
  onDismiss,
  onClose,
}: {
  result: {
    status: "placed" | "pending";
    placedBetId: string;
    bookedOdds: number;
    stake: number;
    ticketId?: string;
  };
  providerShort: string;
  marketLabel?: string;
  outcomeLabel?: string;
  onDismiss: () => void;
  onClose?: () => void;
}) {
  // Live status mirrors the authoritative backend state. Starts from
  // the server's initial reply and upgrades to "placed" once the
  // backend's confirmation tracker writes the DB row, or to "timeout"
  // if the book dropped the bet silently.
  const [live, setLive] = useState<{
    status: LivePlacementStatus;
    ticketId?: string;
    bookedOdds: number;
    stake: number;
  }>({
    status: result.status,
    ticketId: result.ticketId,
    bookedOdds: result.bookedOdds,
    stake: result.stake,
  });

  useEffect(() => {
    if (live.status !== "pending") return;
    const placedBetId = result.placedBetId;
    if (!placedBetId) return;
    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(
          `/api/bets/${encodeURIComponent(placedBetId)}/status`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const body = (await res.json()) as {
          status: LivePlacementStatus;
          ticketId?: string | null;
          bookedOdds?: number;
          stake?: number;
        };
        if (cancelled) return;
        if (body.status === "placed" || body.status === "timeout") {
          setLive({
            status: body.status,
            ticketId: body.ticketId ?? undefined,
            bookedOdds: body.bookedOdds ?? result.bookedOdds,
            stake: body.stake ?? result.stake,
          });
        }
      } catch {
        // Transient fetch failure — keep polling.
      }
    };

    void tick();
    const id = window.setInterval(() => {
      if (Date.now() - startedAt > PENDING_POLL_DEADLINE_MS) {
        window.clearInterval(id);
        if (!cancelled) {
          setLive((prev) =>
            prev.status === "pending" ? { ...prev, status: "timeout" } : prev,
          );
        }
        return;
      }
      void tick();
    }, PENDING_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [live.status, result.placedBetId, result.bookedOdds, result.stake]);

  const isPlaced = live.status === "placed";
  const isTimeout = live.status === "timeout";
  const profit = live.stake * (live.bookedOdds - 1);
  const total = live.stake * live.bookedOdds;

  const tone = isPlaced
    ? "border-emerald-500/60 bg-emerald-500/10"
    : isTimeout
      ? "border-rose-500/60 bg-rose-500/10"
      : "border-amber-500/60 bg-amber-500/10";

  const accent = isPlaced
    ? "text-emerald-700 dark:text-emerald-300"
    : isTimeout
      ? "text-rose-700 dark:text-rose-300"
      : "text-amber-700 dark:text-amber-300";

  const Icon = isPlaced ? CheckCircle2 : isTimeout ? XCircle : Loader2;
  const headline = isPlaced
    ? "Bet Placed"
    : isTimeout
      ? "Confirmation Timeout"
      : "Bet Pending";

  return (
    <div
      className={cn("mt-2 overflow-hidden rounded-lg border-2 shadow-sm", tone)}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2.5">
          <Icon
            className={cn(
              "size-6 shrink-0",
              accent,
              !isPlaced && !isTimeout && "animate-spin",
            )}
          />
          <div className="flex-1 min-w-0">
            <div
              className={cn(
                "text-sm font-bold uppercase tracking-wider",
                accent,
              )}
            >
              {headline}
            </div>
            {outcomeLabel && (
              <div className="text-[11px] text-muted-foreground truncate">
                {marketLabel ? `${marketLabel} → ` : ""}
                <span className="font-semibold text-foreground">
                  {outcomeLabel}
                </span>{" "}
                @ {providerShort}
              </div>
            )}
            {!isPlaced && !isTimeout && (
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Waiting for the book to match the ticket…
              </div>
            )}
            {isTimeout && (
              <div className="text-[10px] text-rose-700/80 dark:text-rose-300/80 mt-0.5">
                No matching ticket appeared in the book feed. Check 9W directly.
              </div>
            )}
          </div>
          {live.ticketId && (
            <div className="text-right shrink-0">
              <div className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                Ticket
              </div>
              <div className="text-[11px] font-mono font-semibold">
                {live.ticketId}
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <SuccessStat
            label="Stake"
            value={`${live.stake.toFixed(0)} ${DISPLAY_CURRENCY}`}
          />
          <SuccessStat label="Odds" value={live.bookedOdds.toFixed(2)} />
          <SuccessStat
            label="Profit"
            value={`+${profit.toFixed(0)} ${DISPLAY_CURRENCY}`}
            tone="positive"
          />
        </div>

        <div className="text-[10px] text-muted-foreground text-center">
          Potential return:{" "}
          <span className="font-mono font-semibold text-foreground">
            {total.toFixed(0)} {DISPLAY_CURRENCY}
          </span>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onDismiss}
            className="flex-1 h-8 text-[11px]"
          >
            Place Another
          </Button>
          {onClose && (
            <Button
              size="sm"
              onClick={onClose}
              className="flex-1 h-8 text-[11px]"
            >
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function SuccessStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive";
}) {
  return (
    <div className="flex flex-col items-center rounded-md border border-border/60 bg-background/50 px-2 py-1.5">
      <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "text-sm font-mono font-bold tabular-nums",
          tone === "positive" && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {value}
      </span>
    </div>
  );
}
