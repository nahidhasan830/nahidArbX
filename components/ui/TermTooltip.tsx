"use client";

/**
 * TermTooltip — wrap any technical word/phrase with an info icon that opens
 * a hover/click tooltip explaining the term. Content lives in
 * `lib/lab/glossary.ts` so every page renders the same definition.
 *
 *   <TermTooltip term="dsr">Deflated Sharpe</TermTooltip>
 *
 * The tooltip also shows a "Learn more →" link pointing to the relevant
 * anchor in `docs/alphasearch.md` when the glossary entry has one.
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
            <Info className="size-3 text-muted-foreground" aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          className="max-w-sm space-y-1.5 leading-relaxed"
        >
          <p className="text-xs font-medium">{entry.short}</p>
          {entry.long && (
            <p className="text-[11px] text-muted-foreground">{entry.long}</p>
          )}
          {entry.learnMoreHref && (
            <a
              href={entry.learnMoreHref}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-primary hover:underline"
            >
              Learn more →
            </a>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
