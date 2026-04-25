"use client";

/**
 * Pre-search data-scope filter editor for the submit-run sheet.
 *
 * UX inversion: every provider/market renders CHECKED by default (= "this
 * is included"), so when the user opens the sheet they see every source
 * already participating in the analysis. Unticking a box EXCLUDES it;
 * re-ticking re-includes. We persist this as `excludeSoftProviders` /
 * `excludeMarketTypes` so the backend contract (empty = all) is unchanged.
 *
 * Live preview POSTs `/api/optimizer/dataset/preview` as the scope
 * changes and renders a `Loader2` spinner while in-flight — no more
 * "computing…" text.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ProviderBadge } from "@/components/ui/ProviderBadge";
import { TermTooltip } from "@/components/ui/TermTooltip";
import { formatMarketType } from "@/lib/formatting/labels";
import { PROVIDER_REGISTRY } from "@/lib/providers/registry";
import type { DataFiltersJson } from "@/lib/optimizer/types";

interface PreviewResponse {
  total: number;
  included: number;
  byProvider: Array<{ provider: string; count: number }>;
  byMarket: Array<{ market: string; count: number }>;
}

async function fetchPreview(
  filters: DataFiltersJson,
): Promise<PreviewResponse> {
  const res = await fetch("/api/optimizer/dataset/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filters),
  });
  if (!res.ok) throw new Error(`preview ${res.status}`);
  return res.json();
}

export interface DataFiltersSectionProps {
  value: DataFiltersJson;
  onChange: (next: DataFiltersJson) => void;
}

export function DataFiltersSection({
  value,
  onChange,
}: DataFiltersSectionProps) {
  const { data: catalog } = useQuery({
    queryKey: ["optimizer", "preview", "catalog"],
    queryFn: () => fetchPreview({}),
    staleTime: 60_000,
  });

  const previewQ = useQuery({
    queryKey: ["optimizer", "preview", value],
    queryFn: () => fetchPreview(value),
    placeholderData: (prev) => prev,
  });

  const allProviders = catalog?.byProvider ?? [];
  const allMarkets = catalog?.byMarket ?? [];

  // Inverted semantics: checkbox is CHECKED when the source is INCLUDED
  // (i.e. NOT in the exclude list). Unchecking adds it to excludes.
  const isProviderIncluded = (p: string) =>
    !(value.excludeSoftProviders ?? []).includes(p);
  const isMarketIncluded = (m: string) =>
    !(value.excludeMarketTypes ?? []).includes(m);

  const toggleProvider = (p: string, included: boolean) => {
    const set = new Set(value.excludeSoftProviders ?? []);
    if (included) set.delete(p);
    else set.add(p);
    const arr = Array.from(set);
    onChange({
      ...value,
      excludeSoftProviders: arr.length > 0 ? arr : undefined,
    });
  };

  const toggleMarket = (m: string, included: boolean) => {
    const set = new Set(value.excludeMarketTypes ?? []);
    if (included) set.delete(m);
    else set.add(m);
    const arr = Array.from(set);
    onChange({
      ...value,
      excludeMarketTypes: arr.length > 0 ? arr : undefined,
    });
  };

  const togglePlacedOnly = () =>
    onChange({ ...value, placedOnly: !value.placedOnly });

  const setEventFrom = (s: string) =>
    onChange({ ...value, eventStartFrom: s ? toIso(s) : undefined });
  const setEventTo = (s: string) =>
    onChange({ ...value, eventStartTo: s ? toIso(s) : undefined });

  const previewIncluded = previewQ.data?.included ?? 0;
  const previewTotal = previewQ.data?.total ?? catalog?.total ?? 0;
  const pct =
    previewTotal > 0 ? Math.round((previewIncluded / previewTotal) * 100) : 0;
  const tooFew = previewIncluded > 0 && previewIncluded < 50;
  const isLoading = previewQ.isFetching;

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium inline-flex items-center gap-1.5">
          <Filter className="size-3.5" />
          <TermTooltip term="data_scope">Data scope</TermTooltip>
        </h4>
        <div
          className={`text-[11px] tabular-nums inline-flex items-center gap-1.5 ${
            tooFew ? "text-amber-600" : "text-muted-foreground"
          }`}
        >
          {isLoading && !previewQ.data ? (
            <>
              <Loader2 className="size-3 animate-spin" aria-hidden />
              <span>loading…</span>
            </>
          ) : (
            <>
              {isLoading && (
                <Loader2
                  className="size-3 animate-spin opacity-60"
                  aria-hidden
                />
              )}
              <span>
                {previewIncluded.toLocaleString()} /{" "}
                {previewTotal.toLocaleString()} bets · {pct}%
              </span>
            </>
          )}
        </div>
      </div>

      {/* Visual preview bar */}
      {previewTotal > 0 && (
        <div
          className="h-1 w-full rounded-full bg-muted overflow-hidden"
          aria-hidden
        >
          <div
            className={`h-full rounded-full transition-all ${
              tooFew ? "bg-amber-500" : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {tooFew && (
        <p className="text-[13px] text-amber-600">
          Below 50 bets — CPCV needs at least that many. Loosen filters or this
          run will fail.
        </p>
      )}

      <p className="text-[13px] text-muted-foreground leading-relaxed">
        All sources start <strong>included</strong> (every checkbox ticked) —
        untick a box to drop that source from this run.
      </p>

      {/* Soft providers */}
      {allProviders.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-foreground/80">
              Soft providers
            </p>
            <SelectAllToggle
              allIncluded={allProviders.every((p) =>
                isProviderIncluded(p.provider),
              )}
              onToggle={(all) => {
                onChange({
                  ...value,
                  excludeSoftProviders: all
                    ? undefined
                    : allProviders.map((p) => p.provider),
                });
              }}
            />
          </div>
          <div className="space-y-1">
            {allProviders.map(({ provider, count }) => {
              const known = Boolean(
                PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY],
              );
              return (
                <label
                  key={provider}
                  className="flex items-center gap-2 cursor-pointer text-xs py-1 px-1.5 rounded hover:bg-muted/40"
                >
                  <Checkbox
                    checked={isProviderIncluded(provider)}
                    onCheckedChange={(v) =>
                      toggleProvider(provider, Boolean(v))
                    }
                  />
                  <span className="flex-1 inline-flex items-center gap-2 min-w-0">
                    {known ? (
                      <ProviderBadge id={provider} size="sm" withDot />
                    ) : (
                      <span className="truncate">{provider}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground tabular-nums text-[11px]">
                    {count.toLocaleString()}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Market types */}
      {allMarkets.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium text-foreground/80">
              Market types
            </p>
            <SelectAllToggle
              allIncluded={allMarkets
                .slice(0, 12)
                .every((m) => isMarketIncluded(m.market))}
              onToggle={(all) => {
                onChange({
                  ...value,
                  excludeMarketTypes: all
                    ? undefined
                    : allMarkets.slice(0, 12).map((m) => m.market),
                });
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {allMarkets.slice(0, 12).map(({ market, count }) => (
              <label
                key={market}
                className="flex items-center gap-2 cursor-pointer text-xs py-1 px-1.5 rounded hover:bg-muted/40 min-w-0"
                title={market}
              >
                <Checkbox
                  checked={isMarketIncluded(market)}
                  onCheckedChange={(v) => toggleMarket(market, Boolean(v))}
                />
                <span className="flex-1 truncate">
                  {formatMarketType(market)}
                </span>
                <span className="text-muted-foreground tabular-nums text-[11px]">
                  {count.toLocaleString()}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Date range + placed-only */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-foreground/80">
            Event from
          </label>
          <Input
            type="date"
            value={value.eventStartFrom?.slice(0, 10) ?? ""}
            onChange={(e) => setEventFrom(e.target.value)}
            className="h-7 text-[11px]"
          />
        </div>
        <div className="space-y-1">
          <label className="text-[11px] font-medium text-foreground/80">
            Event to
          </label>
          <Input
            type="date"
            value={value.eventStartTo?.slice(0, 10) ?? ""}
            onChange={(e) => setEventTo(e.target.value)}
            className="h-7 text-[11px]"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer text-[11px]">
        <Checkbox
          checked={value.placedOnly ?? false}
          onCheckedChange={togglePlacedOnly}
        />
        <span>Only include bets that were actually placed</span>
      </label>
    </div>
  );
}

function SelectAllToggle({
  allIncluded,
  onToggle,
}: {
  allIncluded: boolean;
  onToggle: (selectAll: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!allIncluded)}
      className="text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted underline-offset-2"
    >
      {allIncluded ? "Clear all" : "Select all"}
    </button>
  );
}

const toIso = (yyyymmdd: string): string => {
  // Treat the input as UTC-midnight to avoid timezone surprises in CV splits.
  return `${yyyymmdd}T00:00:00.000Z`;
};
