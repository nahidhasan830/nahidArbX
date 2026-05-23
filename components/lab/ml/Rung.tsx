"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot } from "./StatusDot";
import { RungEvidence } from "./RungEvidence";
import {
  formatRungNumber,
  type RungDefinition,
  type RungStatus,
  type RungVerdict,
} from "@/lib/lab/ml/rungs";
import type { PipelineData } from "./types";

interface Props {
  definition: RungDefinition;
  verdict: RungVerdict;
  data: PipelineData;
}

const PRIMARY_TONE: Record<RungStatus, string> = {
  pass: "text-foreground",
  warn: "text-amber-300",
  fail: "text-rose-300",
  pending: "text-muted-foreground",
  blocked: "text-muted-foreground/60",
};

const ROW_BG: Record<RungStatus, string> = {
  pass: "",
  warn: "bg-amber-500/[0.03]",
  fail: "bg-rose-500/[0.04]",
  pending: "",
  blocked: "opacity-60",
};

const STATUS_LABEL: Record<RungStatus, string> = {
  pass: "Passing",
  warn: "Needs attention",
  fail: "Failing",
  pending: "Pending",
  blocked: "Blocked",
};

const STATUS_BADGE_LABEL: Record<RungStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  pending: "PEND",
  blocked: "BLOCK",
};

const STATUS_BADGE_TONE: Record<RungStatus, string> = {
  pass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  fail: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  pending: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  blocked: "bg-zinc-700/20 text-zinc-500 border-zinc-700/30",
};

/**
 * Single rung row in the pipeline ladder. Click anywhere on the row
 * to expand the operator-facing detail panel.
 *
 * Status is communicated three ways for accessibility:
 *   1. Colored dot (color)
 *   2. Text badge "PASS" / "WARN" / "FAIL" (text)
 *   3. ARIA label on the row (screen readers)
 */
export function Rung({ definition, verdict, data }: Props) {
  const [expanded, setExpanded] = useState(false);

  const hasActionableContent =
    verdict.status !== "blocked" &&
    (definition.inputs != null || (definition.actions ?? []).length > 0);

  return (
    <div
      id={`rung-${definition.number}`}
      className={cn("group relative scroll-mt-24", ROW_BG[verdict.status])}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={`Gate ${definition.number}: ${definition.title} — ${STATUS_LABEL[verdict.status]}`}
        className={cn(
          "w-full text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none",
          "grid grid-cols-[auto_auto_auto_1fr_auto_auto] items-center gap-x-3 px-4 py-2.5 sm:gap-x-4",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex items-center">
              <StatusDot status={verdict.status} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="text-sm">
            {STATUS_LABEL[verdict.status]}
          </TooltipContent>
        </Tooltip>

        <span className="font-mono text-xs text-muted-foreground tabular-nums w-5 text-center">
          {formatRungNumber(definition.number)}
        </span>

        <span
          className={cn(
            "hidden rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tracking-wider sm:inline-flex",
            STATUS_BADGE_TONE[verdict.status],
          )}
          aria-hidden
        >
          {STATUS_BADGE_LABEL[verdict.status]}
        </span>

        <div className="min-w-0">
          <h3 className="text-sm font-medium leading-snug text-foreground">
            {definition.title}
          </h3>
          {verdict.secondary && (
            <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
              {verdict.secondary}
            </p>
          )}
          {verdict.action && (
            <p className="mt-1 text-[12.5px] leading-snug text-foreground/85">
              <span className="text-muted-foreground">→ </span>
              {verdict.action}
            </p>
          )}
        </div>

        <div
          className={cn(
            "font-mono text-[15px] font-semibold tabular-nums whitespace-nowrap",
            PRIMARY_TONE[verdict.status],
          )}
        >
          {verdict.primary}
        </div>

        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
            !hasActionableContent && "opacity-30",
          )}
        />
      </button>

      {expanded && <RungEvidence definition={definition} data={data} />}
    </div>
  );
}
