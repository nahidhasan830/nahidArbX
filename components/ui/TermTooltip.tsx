"use client";

/**
 * TermTooltip — wrap any technical word/phrase with an info icon that opens
 * a hover/click tooltip explaining the term. Content lives in
 * `lib/lab/glossary.ts` so every page renders the same definition.
 *
 *   <TermTooltip term="dsr">Deflated Sharpe</TermTooltip>
 *
 * The tooltip shows two flowing paragraphs (no rigid section labels):
 *   - short      (bold one-line headline)
 *   - example    (plain-English explanation that includes a concrete
 *                 betting illustration — provider, market, real-looking
 *                 numbers — without the old "For your bets:" prefix)
 *   - objective  (italic one-liner shown ONLY on choice-type entries
 *                 like algorithms / staking schemes — answers
 *                 "why pick this?" without the old "What you'll achieve:" prefix)
 *
 * The legacy `long` field is no longer rendered. See CLAUDE.md →
 * "Explanatory copy" for the plain-language voice convention.
 */

import * as React from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getTerm, type TermId } from "@/lib/lab/glossary";

export interface TermTooltipProps {
  term: TermId;
  children?: React.ReactNode;
  /** Hide the info icon (useful when the term is the icon itself). */
  iconOnly?: boolean;
  className?: string;
}

export function TermTooltip({
  term,
  children,
  iconOnly = false,
  className,
}: TermTooltipProps) {
  const entry = getTerm(term);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 ${className ?? ""}`}
          >
            {!iconOnly && children}
            <Info className="size-3.5 text-muted-foreground" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-md space-y-2.5 leading-relaxed px-3.5 py-3"
        >
          <p className="text-sm font-semibold text-foreground">{entry.short}</p>
          {entry.example && (
            <p className="text-[13px] text-muted-foreground">{entry.example}</p>
          )}
          {entry.objective && (
            <p className="text-[13px] italic text-muted-foreground">
              {entry.objective}
            </p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
