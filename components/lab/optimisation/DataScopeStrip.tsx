"use client";

/**
 * DataScopeStrip — horizontal chip strip showing what bets the run was
 * scored on. Lifted out of the run-detail page side rail; sits above the
 * chart+table area as metadata about the result exploration below.
 *
 * Empty filter object = "all settled bets" (the default).
 */

import { TermTooltip } from "@/components/ui/TermTooltip";
import { ProviderBadge } from "@/components/ui/ProviderBadge";
import { formatMarketType } from "@/lib/formatting/labels";
import { cn } from "@/lib/utils";

export function DataScopeStrip({
  filters,
  className,
}: {
  filters: Record<string, unknown> | null | undefined;
  className?: string;
}) {
  const arr = (k: string): string[] =>
    filters && Array.isArray(filters[k]) ? (filters[k] as string[]) : [];

  const includedProviders = arr("includeSoftProviders");
  const excludedProviders = arr("excludeSoftProviders");
  const includedMarkets = arr("includeMarketTypes");
  const excludedMarkets = arr("excludeMarketTypes");
  const eventFrom =
    filters && typeof filters.eventStartFrom === "string"
      ? (filters.eventStartFrom as string)
      : null;
  const eventTo =
    filters && typeof filters.eventStartTo === "string"
      ? (filters.eventStartTo as string)
      : null;
  const placedOnly = filters?.placedOnly === true;

  const hasAny =
    includedProviders.length > 0 ||
    excludedProviders.length > 0 ||
    includedMarkets.length > 0 ||
    excludedMarkets.length > 0 ||
    eventFrom !== null ||
    eventTo !== null ||
    placedOnly;

  return (
    <div
      className={cn(
        "h-7 px-3 py-1.5 bg-muted/40 rounded-md border border-border/60 flex items-center gap-2 text-[11px] overflow-x-auto",
        className,
      )}
    >
      <span className="text-muted-foreground inline-flex items-center gap-1 shrink-0">
        <TermTooltip term="data_scope">Data scope</TermTooltip>
      </span>
      {!hasAny ? (
        <span className="text-foreground/80">All settled bets</span>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          {includedProviders.map((p) => (
            <IncludedProviderChip key={`in-${p}`} id={p} />
          ))}
          {excludedProviders.map((p) => (
            <ExcludedProviderChip key={`ex-${p}`} id={p} />
          ))}
          {includedMarkets.map((m) => (
            <MarketChip key={`inm-${m}`} id={m} mode="include" />
          ))}
          {excludedMarkets.map((m) => (
            <MarketChip key={`exm-${m}`} id={m} mode="exclude" />
          ))}
          {eventFrom && <PlainChip>From {eventFrom.slice(0, 10)}</PlainChip>}
          {eventTo && <PlainChip>To {eventTo.slice(0, 10)}</PlainChip>}
          {placedOnly && <PlainChip>Placed only</PlainChip>}
        </div>
      )}
    </div>
  );
}

function PlainChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  );
}

function ExcludedProviderChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/5 px-2 py-0.5 text-[11px] text-red-600 dark:text-red-400">
      <span>−</span>
      <ProviderBadge
        id={id}
        size="sm"
        short
        className="!border-0 !bg-transparent !text-inherit !px-0 !py-0"
      />
    </span>
  );
}

function IncludedProviderChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/5 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
      <span>+</span>
      <ProviderBadge
        id={id}
        size="sm"
        short
        className="!border-0 !bg-transparent !text-inherit !px-0 !py-0"
      />
    </span>
  );
}

function MarketChip({ id, mode }: { id: string; mode: "include" | "exclude" }) {
  const sign = mode === "include" ? "+" : "−";
  const tone =
    mode === "include"
      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
      : "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
        tone,
      )}
    >
      <span>{sign}</span>
      {formatMarketType(id)}
    </span>
  );
}
