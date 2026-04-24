"use client";

/**
 * Pre-search data-scope filter editor for the submit-run sheet.
 *
 * Two key behaviors:
 *  - Defaults to "include everything" (every checkbox unchecked).
 *  - Shows a live "X of Y bets included" preview that POSTs to
 *    /api/optimizer/dataset/preview as the user toggles, so they can see
 *    immediately how aggressive their filter is.
 *
 * This is DIFFERENT from the search-space dimensions (e.g. `soft_providers`
 * subset). Those are the dimensions the optimizer SEARCHES OVER. This is
 * the user's pre-search data scope — what gets included at all.
 */

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { TermTooltip } from "@/components/ui/TermTooltip";
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
  // Initial preview with empty filters → discover what providers/markets exist
  // in the data so we can render checkboxes with real labels.
  const { data: catalog } = useQuery({
    queryKey: ["optimizer", "preview", "catalog"],
    queryFn: () => fetchPreview({}),
    staleTime: 60_000,
  });

  // Live preview re-runs every time the filter changes.
  const previewQ = useQuery({
    queryKey: ["optimizer", "preview", value],
    queryFn: () => fetchPreview(value),
    placeholderData: (prev) => prev,
  });

  const allProviders = catalog?.byProvider ?? [];
  const allMarkets = catalog?.byMarket ?? [];

  const isProviderExcluded = (p: string) =>
    (value.excludeSoftProviders ?? []).includes(p);
  const isMarketExcluded = (m: string) =>
    (value.excludeMarketTypes ?? []).includes(m);

  const toggleExcludeProvider = (p: string) => {
    const set = new Set(value.excludeSoftProviders ?? []);
    if (set.has(p)) set.delete(p);
    else set.add(p);
    onChange({ ...value, excludeSoftProviders: Array.from(set) });
  };

  const toggleExcludeMarket = (m: string) => {
    const set = new Set(value.excludeMarketTypes ?? []);
    if (set.has(m)) set.delete(m);
    else set.add(m);
    onChange({ ...value, excludeMarketTypes: Array.from(set) });
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

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium inline-flex items-center gap-1.5">
          <Filter className="size-3.5" />
          <TermTooltip term="data_scope">Data scope</TermTooltip>
        </h4>
        <div
          className={`text-[11px] tabular-nums ${
            tooFew ? "text-amber-600" : "text-muted-foreground"
          }`}
        >
          {previewQ.isLoading
            ? "computing…"
            : `${previewIncluded.toLocaleString()} / ${previewTotal.toLocaleString()} bets · ${pct}%`}
        </div>
      </div>

      {tooFew && (
        <p className="text-[10px] text-amber-600">
          Below 50 bets — CPCV needs at least that many. Loosen filters or this
          run will fail.
        </p>
      )}

      <p className="text-[10px] text-muted-foreground">
        Default = include every settled bet. Tick a checkbox to{" "}
        <strong>exclude</strong> that source from this run.
      </p>

      {/* Soft providers */}
      {allProviders.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Exclude soft providers
          </p>
          <div className="grid grid-cols-1 gap-1">
            {allProviders.map(({ provider, count }) => (
              <label
                key={provider}
                className="flex items-center gap-2 cursor-pointer text-[11px]"
              >
                <Checkbox
                  checked={isProviderExcluded(provider)}
                  onCheckedChange={() => toggleExcludeProvider(provider)}
                />
                <span className="flex-1">{provider}</span>
                <span className="text-muted-foreground tabular-nums">
                  {count}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Market types */}
      {allMarkets.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Exclude market types
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {allMarkets.slice(0, 12).map(({ market, count }) => (
              <label
                key={market}
                className="flex items-center gap-2 cursor-pointer text-[11px]"
              >
                <Checkbox
                  checked={isMarketExcluded(market)}
                  onCheckedChange={() => toggleExcludeMarket(market)}
                />
                <span className="flex-1 truncate">{market}</span>
                <span className="text-muted-foreground tabular-nums">
                  {count}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Date range + placed-only */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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
          <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
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

const toIso = (yyyymmdd: string): string => {
  // Treat the input as UTC-midnight to avoid timezone surprises in CV splits.
  return `${yyyymmdd}T00:00:00.000Z`;
};
