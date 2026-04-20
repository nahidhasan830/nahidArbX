"use client";

import { useState } from "react";
import {
  ChevronRight,
  FlaskConical,
  Loader2,
  Save,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useBacktestRule, useCreateStrategy } from "@/lib/backtest/hooks";
import type {
  BacktestRuleResult,
  ProposedRule,
  ProposeResponse,
} from "@/lib/backtest/api-client";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  loading: boolean;
  response: ProposeResponse | null;
};

type PerRuleState = {
  oos?: BacktestRuleResult;
  oosLoading?: boolean;
  oosError?: string;
  promoting?: boolean;
  promoted?: boolean;
};

const fmtPct = (n: number | null, signed = false, digits = 1): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = signed && n > 0 ? "+" : "";
  return `${s}${n.toFixed(digits)}%`;
};

const signedClass = (n: number | null): string => {
  if (n == null) return "text-muted-foreground";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-rose-400";
  return "text-foreground";
};

const CONFIDENCE_COLORS: Record<ProposedRule["confidence"], string> = {
  low: "bg-muted text-muted-foreground border-border",
  medium: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  high: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
};

const summarizeFilters = (f: ProposedRule["filters"]): string => {
  const parts: string[] = [];
  if (f.marketTypes?.length) parts.push(`markets: ${f.marketTypes.join(",")}`);
  if (f.softProviders?.length)
    parts.push(`books: ${f.softProviders.join(",")}`);
  if (f.minEv != null || f.maxEv != null)
    parts.push(`EV: ${f.minEv ?? "–∞"} to ${f.maxEv ?? "+∞"}`);
  if (f.oddsMin != null || f.oddsMax != null)
    parts.push(`odds: ${f.oddsMin ?? "–∞"} to ${f.oddsMax ?? "+∞"}`);
  if (f.tickMin != null) parts.push(`tick ≥ ${f.tickMin}`);
  if (f.timeScope) parts.push(`scope=${f.timeScope}`);
  if (f.competition) parts.push(`comp=${f.competition}`);
  if (f.atomId) parts.push(`atom=${f.atomId}`);
  return parts.length ? parts.join(" · ") : "(no filters)";
};

export function ProposedRulesDialog({
  open,
  onOpenChange,
  loading,
  response,
}: Props) {
  const [state, setState] = useState<Record<string, PerRuleState>>({});
  const backtestMut = useBacktestRule();
  const createStrategyMut = useCreateStrategy();

  const updateRuleState = (ruleId: string, patch: PerRuleState) => {
    setState((s) => ({ ...s, [ruleId]: { ...(s[ruleId] ?? {}), ...patch } }));
  };

  const handleBacktest = async (rule: ProposedRule) => {
    updateRuleState(rule.ruleId, {
      oosLoading: true,
      oosError: undefined,
      oos: undefined,
    });
    try {
      const result = await backtestMut.mutateAsync({
        filters: rule.filters,
        oosFraction: 0.3,
      });
      updateRuleState(rule.ruleId, { oosLoading: false, oos: result });
    } catch (err) {
      updateRuleState(rule.ruleId, {
        oosLoading: false,
        oosError: (err as Error).message,
      });
    }
  };

  const handlePromote = async (rule: ProposedRule) => {
    updateRuleState(rule.ruleId, { promoting: true });
    try {
      const perRule = state[rule.ruleId] ?? {};
      const rationaleParts = [
        rule.rationale,
        "",
        `Stake multiplier: ${rule.stakeMultiplier}`,
        `Expected edge: ${rule.expectedEdgePct.toFixed(2)}%`,
        `Confidence: ${rule.confidence}`,
        `Risks:\n  - ${rule.knownRisks.join("\n  - ")}`,
      ];
      if (perRule.oos) {
        const o = perRule.oos;
        rationaleParts.push(
          "",
          `OOS backtest (${o.n} rows from held-out ${(0.3 * 100).toFixed(0)}% window):`,
          `  ROI=${fmtPct(o.roiPct, true, 1)}, CLV=${fmtPct(o.clvPct, true, 2)}, z=${o.z?.toFixed(2) ?? "—"}, p=${o.p == null ? "—" : o.p.toFixed(3)}`,
        );
      }

      await createStrategyMut.mutateAsync({
        name: rule.ruleId,
        description: rule.rationale.slice(0, 120),
        filters: {
          marketTypes: rule.filters.marketTypes,
          softProviders: rule.filters.softProviders,
          minEv: rule.filters.minEv,
          maxEv: rule.filters.maxEv,
        },
        stakeMultiplier: rule.stakeMultiplier,
        origin: "ai",
        rationale: rationaleParts.join("\n"),
        status: "candidate",
        metricsSnapshot: perRule.oos
          ? (perRule.oos as unknown as Record<string, unknown>)
          : null,
      });

      updateRuleState(rule.ruleId, { promoting: false, promoted: true });
      toast.success(`Promoted "${rule.ruleId}" to candidate strategy`);
    } catch (err) {
      updateRuleState(rule.ruleId, { promoting: false });
      toast.error(`Promote failed: ${(err as Error).message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Proposed strategies</DialogTitle>
          <DialogDescription>
            {response
              ? `Gemini returned ${response.rules.length} rule${response.rules.length === 1 ? "" : "s"} (${response.model}). Back-test each on held-out data before promoting.`
              : "Gemini is analysing the pivot metrics…"}
          </DialogDescription>
        </DialogHeader>

        <TooltipProvider delayDuration={200}>
          <div className="flex-1 overflow-auto space-y-3 pr-1">
            {loading && (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 className="size-4 animate-spin mr-2" />
                Reasoning with Gemini 3.1 Pro…
              </div>
            )}

            {!loading && response && response.rules.length === 0 && (
              <div className="text-[12px] text-muted-foreground py-8 text-center">
                Gemini didn&apos;t find any clearly profitable rules in the
                current slice. Try changing the pivot group-by or widening the
                sample.
              </div>
            )}

            {!loading &&
              response?.rules.map((rule) => {
                const rs = state[rule.ruleId] ?? {};
                return (
                  <div
                    key={rule.ruleId}
                    className="rounded-md border border-border bg-muted/20 p-3 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Sparkles className="size-3.5 text-purple-400" />
                          <span className="font-medium text-[13px]">
                            {rule.ruleId}
                          </span>
                          <Badge
                            className={cn(
                              "h-4 px-1.5 text-[9px] border",
                              CONFIDENCE_COLORS[rule.confidence],
                            )}
                            variant="outline"
                          >
                            {rule.confidence}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            × {rule.stakeMultiplier.toFixed(2)} stake · expect{" "}
                            {fmtPct(rule.expectedEdgePct, true, 1)}
                          </span>
                        </div>
                        <div className="text-[11px] text-foreground/90 mt-1">
                          {rule.rationale}
                        </div>
                        <div className="text-[10px] text-muted-foreground/80 font-mono mt-1 truncate">
                          {summarizeFilters(rule.filters)}
                        </div>
                      </div>
                    </div>

                    {rule.knownRisks.length > 0 && (
                      <details className="text-[10px]">
                        <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
                          Known risks ({rule.knownRisks.length})
                        </summary>
                        <ul className="list-disc list-inside space-y-0.5 mt-1 text-muted-foreground/90">
                          {rule.knownRisks.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </details>
                    )}

                    {/* OOS backtest result */}
                    {rs.oos && (
                      <div className="rounded border border-border bg-background/40 p-2 text-[11px]">
                        <div className="font-semibold text-muted-foreground text-[10px] uppercase tracking-wider mb-1">
                          Out-of-sample backtest
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                          <Stat label="N" value={String(rs.oos.n)} />
                          <Stat
                            label="W/L"
                            value={`${rs.oos.wins}/${rs.oos.losses}`}
                          />
                          <Stat
                            label="ROI"
                            value={fmtPct(rs.oos.roiPct, true, 1)}
                            className={signedClass(rs.oos.roiPct)}
                          />
                          <Stat
                            label="Win%"
                            value={fmtPct(rs.oos.winRatePct, false, 1)}
                          />
                          <Stat
                            label="CLV"
                            value={fmtPct(rs.oos.clvPct, true, 2)}
                            className={signedClass(rs.oos.clvPct)}
                          />
                          <Stat label="z" value={rs.oos.z?.toFixed(2) ?? "—"} />
                          <Stat
                            label="p"
                            value={
                              rs.oos.p == null
                                ? "—"
                                : rs.oos.p < 0.001
                                  ? "<0.001"
                                  : rs.oos.p.toFixed(3)
                            }
                          />
                        </div>
                        {rs.oos.n === 0 && (
                          <div className="text-[10px] text-amber-300 mt-1">
                            No rows match this rule in the held-out window — too
                            narrow or no overlapping data.
                          </div>
                        )}
                      </div>
                    )}

                    {rs.oosError && (
                      <div className="text-[10px] text-rose-300">
                        {rs.oosError}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-[11px] gap-1"
                            onClick={() => handleBacktest(rule)}
                            disabled={rs.oosLoading}
                          >
                            {rs.oosLoading ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <FlaskConical className="size-3" />
                            )}
                            {rs.oos ? "Re-test" : "Back-test on OOS"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Run this rule against the held-out 30% the LLM
                          didn&apos;t see.
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            className="h-7 px-2 text-[11px] gap-1"
                            onClick={() => handlePromote(rule)}
                            disabled={rs.promoting || rs.promoted}
                          >
                            {rs.promoting ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : rs.promoted ? (
                              <ChevronRight className="size-3" />
                            ) : (
                              <Save className="size-3" />
                            )}
                            {rs.promoted ? "Promoted" : "Promote to strategy"}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {rs.oos
                            ? "Save as candidate strategy with OOS snapshot"
                            : "Save without OOS — you can still re-test later"}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
          </div>
        </TooltipProvider>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <span className="tabular-nums">
      <span className="text-muted-foreground mr-1">{label}</span>
      <span className={cn("font-medium", className)}>{value}</span>
    </span>
  );
}
