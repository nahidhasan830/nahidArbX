"use client";

/**
 * Live model comparison card.
 *
 * Shows the current live model side-by-side with any waiting candidate.
 * The visible labels are operator-facing; tooltips carry the deeper meaning.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ShieldCheck, Target, Trophy, Clock } from "lucide-react";

interface ModelInfo {
  version: number;
  status: string;
  trainingSamples: number;
  oosAucRoc: number;
  deflatedSharpe: number;
  oosRoiMean: number;
  permissionLevel: string | null;
  championToAt?: string | null;
  championPsr?: number;
  championRoiVsPrev?: number;
  championReplacedVersion?: number | null;
}

interface Props {
  champion: ModelInfo | null;
  challenger: ModelInfo | null;
}

export function ChampionChallengerCard({ champion, challenger }: Props) {
  if (!champion && !challenger) return null;

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] backdrop-blur-xl p-3">
      <div className="mb-2 flex items-center gap-2">
        <ShieldCheck className="size-4 text-cyan-400" />
        <h3 className="text-sm font-semibold text-white">
          Live model vs next model
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex size-3.5 cursor-help items-center justify-center rounded-full bg-white/5 border border-white/10 text-white/50 ml-1.5 text-[9px]">?</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[300px] text-xs leading-relaxed">
              The live model scores current bets. The next model is a fresh
              build that must prove it is better on bets it never learned from
              before it can replace the live one.
            </TooltipContent>
          </Tooltip>
        </h3>
      </div>

      {!champion ? (
        <p className="text-[11px] text-white/50 leading-relaxed">
          No live model yet. Train and approve the first model to start scoring.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* ── Champion ── */}
          <ModelPanel
            title="Live model"
            subtitle="Scoring live bets right now"
            icon={<Trophy className="size-3.5 text-amber-400" />}
            model={champion}
            tone="cyan"
            extraRows={
              <>
                {champion.championToAt && (
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/40">Promoted</span>
                    <span className="text-amber-300/80 tabular-nums">
                      {new Date(champion.championToAt).toLocaleDateString()}
                    </span>
                  </div>
                )}
                {champion.championPsr != null && champion.championPsr > 0 && (
                  <div className="flex items-center justify-between text-[11px]">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-white/40 cursor-help border-b border-dotted border-white/25">
                          Promotion confidence
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[260px] text-xs">
                        How sure the system was that this model beat the
                        previous live model. It is measured on held-out bets, so
                        the model did not get to learn from those examples first.
                      </TooltipContent>
                    </Tooltip>
                    <span className="font-medium tabular-nums text-cyan-400">
                      {Math.round(champion.championPsr * 100)}%
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px]">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-white/40 cursor-help border-b border-dotted border-white/25">
                        Allowed actions
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px] text-xs">
                      What this model may do with live bets. Observe means watch
                      only, skip weak bets means it can block poor picks, and
                      reduce stake means it can lower bet size when confidence is
                      weak.
                    </TooltipContent>
                  </Tooltip>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest",
                      champion.permissionLevel === "stake_reduce"
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                        : champion.permissionLevel === "gate_only"
                          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-400"
                          : "border-white/10 bg-white/5 text-white/50",
                    )}
                  >
                    {formatPermission(champion.permissionLevel)}
                  </span>
                </div>
              </>
            }
          />

          {/* ── Challenger ── */}
          {challenger ? (
            <ModelPanel
              title="Next model"
              subtitle={`v${challenger.version} waiting for approval`}
              icon={<Target className="size-3.5 text-purple-400" />}
              model={challenger}
              tone="purple"
              extraRows={
                <>
                  {challenger.oosRoiMean > (champion.oosRoiMean ?? 0) ? (
                    <div className="mt-1 rounded-md bg-emerald-500/10 border border-emerald-500/20 p-1.5 text-[10px] text-emerald-400 leading-tight">
                      Paper return is above the live model. It still needs enough settled bets
                      before promotion is considered.
                    </div>
                  ) : (
                    <div className="mt-1 rounded-md bg-amber-500/10 border border-amber-500/20 p-1.5 text-[10px] text-amber-400 leading-tight">
                      Paper return is below the live model on shared data. Collect more
                      settled examples and retrain when they arrive.
                    </div>
                  )}
                  {challenger.permissionLevel && (
                    <div className="mt-2 text-[10px] text-white/40">
                      Would start at:{" "}
                      <span className="text-white/70 font-medium">
                        {formatPermission(challenger.permissionLevel)}
                      </span>{" "}
                      allowed actions
                    </div>
                  )}
                </>
              }
            />
          ) : (
            <div className="rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] p-3 flex flex-col items-center justify-center text-center">
              <Clock className="size-4 text-white/20 mb-1.5" />
              <p className="text-[11px] text-white/40 leading-relaxed">
                No next model waiting. Train again after enough new settled bets
                arrive; the new build appears here automatically.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Inner panel for a single model ─────────────────────────────────────

function ModelPanel({
  title,
  subtitle,
  icon,
  model,
  tone,
  extraRows,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  model: ModelInfo;
  tone: "cyan" | "purple";
  extraRows: React.ReactNode;
}) {
  const accent =
    tone === "cyan" ? "border-cyan-500/20 bg-cyan-500/5" : "border-purple-500/20 bg-purple-500/5";

  return (
    <div
      className={cn("rounded-lg border p-3 flex flex-col", accent)}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <div>
          <p className="text-sm font-semibold text-white">{title}</p>
          <p className="text-[10px] text-white/50">{subtitle}</p>
        </div>
      </div>

      <div className="space-y-1 flex-1">
        <MetricRow
          label="Winner separation"
          value={model.oosAucRoc.toFixed(3)}
          tone={model.oosAucRoc >= 0.6 ? "text-emerald-400" : "text-amber-400"}
          help="How well the model ranks better bets above worse bets. 0.50 is no better than guessing; higher is better."
        />
        <MetricRow
          label="Luck check"
          value={model.deflatedSharpe.toFixed(3)}
          tone={model.deflatedSharpe >= 0.8 ? "text-emerald-400" : "text-amber-400"}
          help="A score that discounts performance because many model settings were tried. A strong score means the result is less likely to be luck."
        />
        <MetricRow
          label="Paper return"
          value={`${(model.oosRoiMean ?? 0) >= 0 ? "+" : ""}${(model.oosRoiMean ?? 0).toFixed(3)}%`}
          tone={(model.oosRoiMean ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}
          help="Average return per bet measured on hidden past bets. Positive means the model found value in data it did not train on."
        />
        <MetricRow
          label="Trained on"
          value={`${model.trainingSamples.toLocaleString()} examples`}
          tone="text-white/70"
          help="Number of historical settled bets used to train this model. More is generally better up to about 5,000."
        />
        {extraRows}
      </div>
    </div>
  );
}

function formatPermission(permission: string | null): string {
  if (permission === "gate_only") return "skip weak bets";
  if (permission === "stake_reduce") return "reduce weak stakes";
  if (permission === "stake_increase") return "full stake sizing";
  return "observe only";
}

function MetricRow({
  label,
  value,
  tone,
  help,
}: {
  label: string;
  value: string;
  tone: string;
  help: string;
}) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-white/40 cursor-help border-b border-dotted border-white/25 ml-0.5">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px] text-xs leading-relaxed">
          {help}
        </TooltipContent>
      </Tooltip>
      <span className={cn("font-medium tabular-nums", tone)}>{value}</span>
    </div>
  );
}
