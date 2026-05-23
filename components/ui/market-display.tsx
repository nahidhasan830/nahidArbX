"use client";

import * as React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatMarketType, formatAtomLabel } from "@/lib/formatting/labels";

type KnownMarketScope = "FT" | "1H" | "2H";

const SCOPE_LABELS: Record<KnownMarketScope, string> = {
  FT: "Full time",
  "1H": "First half",
  "2H": "Second half",
};

const SCOPE_CLASSES: Record<KnownMarketScope | "UNKNOWN", string> = {
  FT: "border-sky-500/35 bg-sky-500/12 text-sky-600 dark:text-sky-300",
  "1H":
    "border-amber-500/40 bg-amber-500/14 text-amber-700 dark:text-amber-300",
  "2H":
    "border-violet-500/40 bg-violet-500/14 text-violet-700 dark:text-violet-300",
  UNKNOWN:
    "border-border bg-muted/60 text-muted-foreground dark:bg-muted/40",
};

export function normalizeMarketScope(
  scope: string | null | undefined,
): KnownMarketScope | null {
  const upper = scope?.trim().toUpperCase();
  if (upper === "FT" || upper === "1H" || upper === "2H") return upper;
  return null;
}

export function inferMarketScope(
  value: string | null | undefined,
): KnownMarketScope | null {
  const input = value?.trim();
  if (!input) return null;
  const lower = input.toLowerCase();

  if (
    lower.startsWith("1h_") ||
    lower.startsWith("1h ") ||
    lower.includes("first half") ||
    lower.includes("1st half")
  ) {
    return "1H";
  }

  if (
    lower.startsWith("2h_") ||
    lower.startsWith("2h ") ||
    lower.includes("second half") ||
    lower.includes("2nd half")
  ) {
    return "2H";
  }

  if (
    lower.startsWith("ft_") ||
    lower.startsWith("ft ") ||
    lower.endsWith(" ft") ||
    lower.includes("full time")
  ) {
    return "FT";
  }

  return null;
}

export function inferMarketScopeFromBetId(
  betId: string | null | undefined,
): KnownMarketScope | null {
  const familyId = betId?.split("|")[1];
  return inferMarketScope(familyId);
}

export function stripMarketScopeText(label: string): string {
  return label
    .replace(/\s*\b(?:FT|1H|2H)\b\s*$/i, "")
    .replace(/^\s*(?:Full Time|First Half|1st Half|Second Half|2nd Half)\s+/i, "")
    .trim();
}

export function formatScopedMarketText({
  marketType,
  marketLabel,
  familyLine,
  selection,
  formatSelection = true,
}: {
  marketType?: string | null;
  marketLabel?: string | null;
  familyLine?: number | string | null;
  selection?: string | null;
  formatSelection?: boolean;
}): string {
  const base = marketLabel
    ? stripMarketScopeText(marketLabel)
    : marketType
      ? formatMarketType(marketType)
      : "Market";
  const line = familyLine != null && familyLine !== "" ? ` ${familyLine}` : "";
  const selectionLabel = selection
    ? formatSelection
      ? formatAtomLabel(selection)
      : selection
    : "";
  return selectionLabel ? `${base}${line} · ${selectionLabel}` : `${base}${line}`;
}

export function marketScopeLabel(scope: string | null | undefined): string {
  const normalized = normalizeMarketScope(scope);
  return normalized ? SCOPE_LABELS[normalized] : "Market scope";
}

export function MarketScopeBadge({
  scope,
  className,
  withTooltip = true,
}: {
  scope: string | null | undefined;
  className?: string;
  withTooltip?: boolean;
}) {
  const normalized = normalizeMarketScope(scope);
  const label = normalized ?? scope?.trim().toUpperCase() ?? "N/A";
  const badge = (
    <span
      className={cn(
        "inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded border px-1 text-[9px] font-bold leading-none tracking-normal tabular-nums",
        SCOPE_CLASSES[normalized ?? "UNKNOWN"],
        className,
      )}
    >
      {label}
    </span>
  );

  if (!withTooltip) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="top">{marketScopeLabel(normalized)}</TooltipContent>
    </Tooltip>
  );
}

export function MarketDisplay({
  marketType,
  marketLabel,
  timeScope,
  familyLine,
  selection,
  formatSelection = true,
  className,
  textClassName,
  selectionClassName,
  badgeClassName,
  showSelectionInline = true,
}: {
  marketType?: string | null;
  marketLabel?: string | null;
  timeScope?: string | null;
  familyLine?: number | string | null;
  selection?: string | null;
  formatSelection?: boolean;
  className?: string;
  textClassName?: string;
  selectionClassName?: string;
  badgeClassName?: string;
  showSelectionInline?: boolean;
}) {
  const scope =
    normalizeMarketScope(timeScope) ??
    inferMarketScope(marketLabel) ??
    inferMarketScope(marketType);
  const marketText = formatScopedMarketText({
    marketType,
    marketLabel,
    familyLine,
  });
  const selectionText = selection
    ? formatSelection
      ? formatAtomLabel(selection)
      : selection
    : "";

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center justify-center gap-1.5 align-middle",
        className,
      )}
    >
      <MarketScopeBadge scope={scope} className={badgeClassName} />
      <span className={cn("min-w-0 truncate", textClassName)}>
        {marketText}
      </span>
      {showSelectionInline && selectionText && (
        <>
          <span className="shrink-0 text-muted-foreground/45">·</span>
          <span className={cn("min-w-0 truncate", selectionClassName)}>
            {selectionText}
          </span>
        </>
      )}
    </span>
  );
}
