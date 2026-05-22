"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { PipelineData } from "./types";

interface Props {
  data: PipelineData;
}

interface ProbeResult {
  simplePass: boolean;
  modelEdgePass: boolean;
  combinedVerdict: "place" | "skip-low-ev" | "skip-wrong-market" | "skip-model";
  permission: string;
  staking: {
    label: string;
    multiplier: string | null;
    explanation: string;
  };
}

/**
 * Hypothetical-bet probe.
 *
 * Lets the operator step through the same decision tree the live
 * pipeline applies, without needing a real value bet to fire. Inputs:
 *
 *   - market type
 *   - EV% (the simple-rule input)
 *   - model edge% (the ML gate input)
 *
 * Outputs the gate verdict and what the staker would do at the
 * deployed model's permission level.
 */
export function WhatIfProbe({ data }: Props) {
  const allowedMarkets = data.paperEvaluation.simpleRule.marketTypes;
  const minEv = data.paperEvaluation.simpleRule.minEvPct;
  const policyEdge = data.paperEvaluation.mlModelEdgeThresholdPct;
  const permission = data.deploymentGate.permissionLevel;
  const modelLoaded = data.inference.modelLoaded;

  const [market, setMarket] = useState<string>(allowedMarkets[0] ?? "MATCH_RESULT");
  const [evPctText, setEvPctText] = useState("4");
  const [modelEdgeText, setModelEdgeText] = useState("5");

  const result = useMemo<ProbeResult>(() => {
    const evPct = Number(evPctText);
    const modelEdge = Number(modelEdgeText);
    const safeEv = Number.isFinite(evPct) ? evPct : 0;
    const safeEdge = Number.isFinite(modelEdge) ? modelEdge : 0;

    const simplePass =
      safeEv >= minEv && (allowedMarkets as readonly string[]).includes(market);
    const modelEdgePass = safeEdge > policyEdge;

    let combined: ProbeResult["combinedVerdict"];
    if (!simplePass && !(allowedMarkets as readonly string[]).includes(market)) {
      combined = "skip-wrong-market";
    } else if (!simplePass) {
      combined = "skip-low-ev";
    } else if (!modelEdgePass && modelLoaded) {
      combined = "skip-model";
    } else {
      combined = "place";
    }

    let stakingLabel = "Pass-through";
    let stakingMult: string | null = "1.00×";
    let explanation =
      "No deployed model — the auto-placer ignores ML and uses the rule-based stake.";

    if (modelLoaded) {
      switch (permission) {
        case "observe":
          stakingLabel = "Observe (logged, no effect)";
          stakingMult = "1.00×";
          explanation =
            "Model is observe-only. Score is recorded but does not affect placement.";
          break;
        case "gate_only":
          stakingLabel = "Gate Only";
          stakingMult = combined === "place" ? "1.00×" : "0×";
          explanation =
            combined === "place"
              ? "Model EV clears the policy threshold; rule-based stake is used."
              : "Model EV does not clear the threshold; this bet is skipped.";
          break;
        case "stake_reduce":
          stakingLabel = "Stake Reduce";
          stakingMult = combined === "place" ? "≤ 1.00×" : "0×";
          explanation =
            combined === "place"
              ? "Stake may be reduced based on model confidence; never increased."
              : "Bet skipped because model EV does not clear the threshold.";
          break;
        case "stake_increase":
          stakingLabel = "Stake Adjust";
          stakingMult = combined === "place" ? "0.5× – 1.5×" : "0×";
          explanation =
            combined === "place"
              ? "Full Kelly sizing with model multiplier (capped at 1.5× base)."
              : "Bet skipped because model EV does not clear the threshold.";
          break;
        default:
          stakingLabel = permission;
          stakingMult = null;
      }
    }

    return {
      simplePass,
      modelEdgePass,
      combinedVerdict: combined,
      permission,
      staking: { label: stakingLabel, multiplier: stakingMult, explanation },
    };
  }, [
    evPctText,
    modelEdgeText,
    market,
    minEv,
    policyEdge,
    allowedMarkets,
    permission,
    modelLoaded,
  ]);

  return (
    <section className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-sm">
      <header className="border-b border-border/40 px-5 py-4">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          What-If Probe
        </h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground/80">
          Step through the live decision tree with a hypothetical bet. Same
          gates as the auto-placer; no DB writes.
        </p>
      </header>

      <div className="grid gap-6 p-5 lg:grid-cols-[280px_1fr]">
        <div className="grid gap-3">
          <Field
            label="Market"
            hint="Auto-place only fires on these markets."
          >
            <Select value={market} onValueChange={setMarket}>
              <SelectTrigger className="h-8 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ...new Set([...allowedMarkets, market, "OTHER_MARKET"]),
                ].map((m) => (
                  <SelectItem key={m} value={m} className="text-[13px]">
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="EV %"
            hint={`Rule-based EV at the soft odds. Simple rule fires at ≥ ${minEv}%.`}
          >
            <Input
              type="number"
              step="0.1"
              value={evPctText}
              onChange={(e) => setEvPctText(e.target.value)}
              className="h-8 font-mono text-[13px]"
            />
          </Field>

          <Field
            label="Model edge %"
            hint={`ML edge at the offered odds. Policy threshold is ${policyEdge.toFixed(2)}%.`}
          >
            <Input
              type="number"
              step="0.1"
              value={modelEdgeText}
              onChange={(e) => setModelEdgeText(e.target.value)}
              className="h-8 font-mono text-[13px]"
            />
          </Field>
        </div>

        <div className="grid gap-2.5">
          <Verdict
            ok={result.simplePass}
            title="Simple-EV rule"
            okText={`Passes — EV ≥ ${minEv}% on a covered market.`}
            failText={
              (allowedMarkets as readonly string[]).includes(market)
                ? `EV is below the ${minEv}% threshold.`
                : "Market is outside the simple rule's allowlist."
            }
          />
          <Verdict
            ok={result.modelEdgePass}
            title="Model edge gate"
            okText={`Model edge clears the ${policyEdge.toFixed(2)}% policy threshold.`}
            failText={
              modelLoaded
                ? `Model edge is at or below the ${policyEdge.toFixed(2)}% threshold.`
                : "No deployed model — gate is permissive (pass-through)."
            }
            neutral={!modelLoaded}
          />

          <CombinedVerdict result={result} />

          <div className="rounded-md border border-border/40 bg-background/60 px-4 py-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Staking
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <p className="text-sm text-foreground">{result.staking.label}</p>
              <p className="font-mono text-base font-semibold tabular-nums text-foreground">
                {result.staking.multiplier ?? "—"}
              </p>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {result.staking.explanation}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </span>
      {children}
      <span className="text-[12px] leading-relaxed text-muted-foreground/80">
        {hint}
      </span>
    </label>
  );
}

function Verdict({
  ok,
  title,
  okText,
  failText,
  neutral,
}: {
  ok: boolean;
  title: string;
  okText: string;
  failText: string;
  neutral?: boolean;
}) {
  const icon = neutral ? (
    <MinusCircle className="size-4 shrink-0 text-zinc-400" />
  ) : ok ? (
    <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
  ) : (
    <XCircle className="size-4 shrink-0 text-rose-400" />
  );

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-2.5",
        neutral
          ? "border-zinc-500/20 bg-zinc-500/5"
          : ok
            ? "border-emerald-500/20 bg-emerald-500/5"
            : "border-rose-500/20 bg-rose-500/5",
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">
          {neutral ? failText : ok ? okText : failText}
        </p>
      </div>
    </div>
  );
}

function CombinedVerdict({ result }: { result: ProbeResult }) {
  const label =
    result.combinedVerdict === "place"
      ? "Auto-placer would fire"
      : result.combinedVerdict === "skip-low-ev"
        ? "Skipped — EV below simple-rule threshold"
        : result.combinedVerdict === "skip-wrong-market"
          ? "Skipped — market outside simple-rule allowlist"
          : "Skipped — model edge below policy threshold";
  const ok = result.combinedVerdict === "place";

  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-md border px-4 py-3",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10"
          : "border-amber-500/30 bg-amber-500/10",
      )}
    >
      <p
        className={cn(
          "text-sm font-medium",
          ok ? "text-emerald-200" : "text-amber-200",
        )}
      >
        {label}
      </p>
      <p
        className={cn(
          "font-mono text-[11px] uppercase tracking-[0.16em]",
          ok ? "text-emerald-300/80" : "text-amber-300/80",
        )}
      >
        {result.combinedVerdict.replace(/-/g, " ")}
      </p>
    </div>
  );
}
