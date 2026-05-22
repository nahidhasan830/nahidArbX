"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { Sparkles } from "lucide-react";
import type { OddsMovementData } from "@/lib/bets-history/types";
import {
  getProviderShortName,
  getProviderChartHex,
  isSharpProvider,
} from "@/lib/providers/registry";
import {
  FEATURE_CATALOG,
  CATEGORY_COLORS,
  CATEGORY_TEXT_COLORS,
  formatFeatureValue,
  type FeatureCategory,
} from "@/lib/ml/feature-catalog";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MovementDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Record<string, OddsMovementData> | OddsMovementData | null;
  /** E.g. "Liverpool vs Arsenal" */
  eventLabel: string;
  /** E.g. "Match Result · Home Win" */
  marketLabel: string;
  /** Optional ML feature vector for inline inspection. */
  features?: number[] | null;
  /** Optional ML metadata — shown as a compact info strip when provided. */
  mlMeta?: {
    mlScore: number | null;
    kellyRaw: number | null;
    /** Renamed from mlMultiplier — the model's stake multiplier vs baseline. */
    mlMultiplier: number | null;
    evPct: number | null;
  } | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeProviderStats(d: OddsMovementData) {
  const vals = d.sparkline.map((s) => s[1]);
  if (vals.length === 0)
    return { first: undefined, last: undefined, changePct: 0 };
  const first = vals[0];
  const last = vals[vals.length - 1];
  const changePct =
    first !== 0 ? Math.round(((last - first) / first) * 10000) / 100 : 0;
  return { first, last, changePct };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MovementDetailModal({
  open,
  onOpenChange,
  data,
  eventLabel,
  marketLabel,
  features,
  mlMeta,
}: MovementDetailModalProps) {
  // Lazy-mount: don't render Dialog tree at all when closed.
  if (!open || !data) {
    return null;
  }

  // Normalize data to Record<string, OddsMovementData>
  let dataMap: Record<string, OddsMovementData>;
  if ("sparkline" in data && "provider" in data) {
    const legacy = data as OddsMovementData;
    dataMap = { [legacy.provider]: legacy };
  } else {
    dataMap = data as Record<string, OddsMovementData>;
  }

  const providers = Object.keys(dataMap);
  if (providers.length === 0) return null;

  // Find the primary sharp provider, or default to the first available
  const sharpProviderId =
    providers.find((p) => isSharpProvider(p)) || providers[0];
  const sharpData = dataMap[sharpProviderId];
  if (!sharpData || sharpData.sparkline.length < 2) return null;

  const hasFeatures = Array.isArray(features) && features.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          "p-0 gap-0 overflow-hidden border-white/[0.08] bg-[#0c0e14]/95 backdrop-blur-2xl shadow-2xl shadow-black/80 sm:rounded-2xl",
          hasFeatures ? "max-w-[1080px] max-h-[85vh]" : "max-w-[760px]",
        )}
      >
        <ModalInner
          dataMap={dataMap}
          sharpProviderId={sharpProviderId}
          eventLabel={eventLabel}
          marketLabel={marketLabel}
          features={hasFeatures ? features : undefined}
          mlMeta={mlMeta}
        />
      </DialogContent>
    </Dialog>
  );
}

// ─── Inner content (only mounts when dialog is open) ────────────────────────

function ModalInner({
  dataMap,
  sharpProviderId,
  eventLabel,
  marketLabel,
  features,
  mlMeta,
}: {
  dataMap: Record<string, OddsMovementData>;
  sharpProviderId: string;
  eventLabel: string;
  marketLabel: string;
  features?: number[];
  mlMeta?: MovementDetailModalProps["mlMeta"];
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<
    typeof import("lightweight-charts").createChart
  > | null>(null);
  const seriesMapRef = useRef<
    Record<string, import("lightweight-charts").ISeriesApi<"Area" | "Line">>
  >({});

  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(
    new Set(),
  );
  const hasFeatures = features && features.length > 0;

  const toggleProvider = (id: string) => {
    setHiddenProviders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Sync visibility state with the chart instances
  useEffect(() => {
    Object.entries(seriesMapRef.current).forEach(([id, series]) => {
      series.applyOptions({ visible: !hiddenProviders.has(id) });
    });
  }, [hiddenProviders]);

  const sharpData = dataMap[sharpProviderId];
  const { changePct: sharpChangePct } = computeProviderStats(sharpData);

  const isUp = sharpChangePct > 0.01;
  const isDown = sharpChangePct < -0.01;
  const bottomColor = "rgba(0, 0, 0, 0)";

  // Accent gradient for header
  const accentGradient = isUp
    ? "from-emerald-500/10 via-transparent to-transparent"
    : isDown
      ? "from-rose-500/10 via-transparent to-transparent"
      : "from-slate-500/10 via-transparent to-transparent";

  const chartHeight = hasFeatures ? 280 : 320;

  // Initialize lightweight-charts
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    let isCancelled = false;
    let chart: ReturnType<
      typeof import("lightweight-charts").createChart
    > | null = null;

    // Dynamic import to keep the module lazy
    import("lightweight-charts").then(
      ({
        createChart,
        AreaSeries,
        LineSeries,
        ColorType,
        CrosshairMode,
        LineStyle,
      }) => {
        // Prevent double-render in StrictMode if component unmounted before import resolved
        if (isCancelled || !container.isConnected) return;

        chart = createChart(container, {
          autoSize: true,
          height: chartHeight,
          layout: {
            background: { type: ColorType.Solid, color: "transparent" },
            textColor: "rgba(148, 163, 184, 0.5)",
            fontFamily: "var(--font-mono), ui-monospace, monospace",
            fontSize: 10,
            attributionLogo: false,
          },
          grid: {
            vertLines: { visible: false },
            horzLines: {
              color: "rgba(148, 163, 184, 0.06)",
              style: LineStyle.Dashed,
            },
          },
          crosshair: {
            mode: CrosshairMode.Magnet,
            vertLine: {
              color: "rgba(148, 163, 184, 0.25)",
              width: 1,
              style: LineStyle.Solid,
              labelBackgroundColor: "rgba(15, 23, 42, 0.95)",
            },
            horzLine: {
              color: "rgba(148, 163, 184, 0.25)",
              width: 1,
              style: LineStyle.Solid,
              labelBackgroundColor: "rgba(15, 23, 42, 0.95)",
            },
          },
          rightPriceScale: {
            borderVisible: false,
            scaleMargins: { top: 0.15, bottom: 0.15 },
            alignLabels: false,
          },
          localization: {
            timeFormatter: (time: number) => {
              return format(new Date(time * 1000), "d MMM HH:mm:ss");
            },
          },
          timeScale: {
            borderVisible: false,
            timeVisible: true,
            secondsVisible: true,
            fixLeftEdge: true,
            fixRightEdge: true,
            tickMarkFormatter: (time: number) => {
              return format(new Date(time * 1000), "HH:mm");
            },
          },
          handleScroll: false,
          handleScale: false,
        });

        chartRef.current = chart;

        // Plot all providers
        for (const [providerId, providerData] of Object.entries(dataMap)) {
          if (providerData.sparkline.length < 2) continue;

          const isSharp = providerId === sharpProviderId;

          // Deduplicate timestamps (keep latest value for each second)
          const uniqueSparkMap = new Map<number, number>();
          for (const [ts, value] of providerData.sparkline) {
            uniqueSparkMap.set(Math.floor(ts / 1000), value);
          }
          const chartData = Array.from(uniqueSparkMap.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([time, value]) => ({
              time: time as import("lightweight-charts").UTCTimestamp,
              value,
            }));

          if (isSharp) {
            const hexColor = getProviderChartHex(providerId);
            // Convert hex to rgba for the top gradient
            const r = parseInt(hexColor.slice(1, 3), 16) || 0;
            const g = parseInt(hexColor.slice(3, 5), 16) || 0;
            const b = parseInt(hexColor.slice(5, 7), 16) || 0;
            const topColor = `rgba(${r}, ${g}, ${b}, 0.12)`;

            const series = chart.addSeries(AreaSeries, {
              lineColor: hexColor,
              topColor: topColor,
              bottomColor,
              lineWidth: 2,
              crosshairMarkerRadius: 5,
              crosshairMarkerBorderColor: "rgba(15, 23, 42, 1)",
              crosshairMarkerBorderWidth: 2,
              crosshairMarkerBackgroundColor: hexColor,
              priceFormat: { type: "price", precision: 3, minMove: 0.001 },
            });
            series.setData(chartData);
            seriesMapRef.current[providerId] = series;
          } else {
            const hexColor = getProviderChartHex(providerId);
            const series = chart.addSeries(LineSeries, {
              color: hexColor,
              lineWidth: 2,
              lineStyle: LineStyle.Solid,
              crosshairMarkerRadius: 4,
              crosshairMarkerBackgroundColor: hexColor,
              priceFormat: { type: "price", precision: 3, minMove: 0.001 },
            });
            series.setData(chartData);
            seriesMapRef.current[providerId] = series;
          }
        }

        chart.timeScale().fitContent();
      },
    );

    return () => {
      isCancelled = true;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
    // Only re-create chart when data identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataMap]);

  // ─── Feature grouping ─────────────────────────────────────────────────────
  const featureGroups = hasFeatures
    ? (() => {
        const grouped = new Map<
          FeatureCategory,
          { meta: (typeof FEATURE_CATALOG)[number]; value: number }[]
        >();
        for (let i = 0; i < FEATURE_CATALOG.length; i++) {
          const meta = FEATURE_CATALOG[i];
          if (!grouped.has(meta.cat)) grouped.set(meta.cat, []);
          grouped.get(meta.cat)!.push({ meta, value: features[i] ?? 0 });
        }
        return grouped;
      })()
    : null;

  const CAT_ACCENT: Record<FeatureCategory, string> = {
    Value: "from-emerald-500/5 to-transparent border-emerald-500/20",
    Odds: "from-cyan-500/5 to-transparent border-cyan-500/20",
    Movement: "from-violet-500/5 to-transparent border-violet-500/20",
    Market: "from-amber-500/5 to-transparent border-amber-500/20",
  };

  const CAT_GLOW: Record<FeatureCategory, string> = {
    Value: "hover:shadow-[0_0_20px_rgba(16,185,129,0.08)]",
    Odds: "hover:shadow-[0_0_20px_rgba(6,182,212,0.08)]",
    Movement: "hover:shadow-[0_0_20px_rgba(139,92,246,0.08)]",
    Market: "hover:shadow-[0_0_20px_rgba(245,158,11,0.08)]",
  };

  return (
    <div className="flex relative w-full bg-[#0c0e14] selection:bg-white/10">
      {/* ── Left Column: Header + Chart + Stats ── */}
      <div
        className={cn(
          "flex-1 flex flex-col min-w-0",
          hasFeatures && "mr-[300px]",
        )}
      >
        {/* ── Header with gradient accent ── */}
        <div
          className={cn(
            "relative shrink-0 overflow-hidden",
            `bg-gradient-to-r ${accentGradient}`,
          )}
        >
          {/* Decorative top bar */}
          <div
            className={cn(
              "absolute top-0 inset-x-0 h-[2px]",
              isUp
                ? "bg-gradient-to-r from-emerald-500/0 via-emerald-400/80 to-emerald-500/0"
                : isDown
                  ? "bg-gradient-to-r from-rose-500/0 via-rose-400/80 to-rose-500/0"
                  : "bg-gradient-to-r from-slate-500/0 via-slate-400/50 to-slate-500/0",
            )}
          />

          <DialogHeader className="px-5 pt-4 pb-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pr-8">
              <DialogTitle className="text-base font-semibold leading-snug text-white/90 tracking-tight">
                {eventLabel}
              </DialogTitle>
              <DialogDescription className="text-xs text-white/40 flex items-center gap-2.5">
                <span className="hidden sm:inline-block text-white/20">•</span>
                <span>{marketLabel}</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.06] border border-white/[0.08] px-2 py-0.5 text-[10px] font-mono tabular-nums text-white/60 shadow-inner">
                  <span className="size-1.5 rounded-full bg-emerald-400/80 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse" />
                  {sharpData.totalTicks} ticks
                </span>
              </DialogDescription>
            </div>
          </DialogHeader>

          {/* ── ML metadata strip (Shadow A/B context) ── */}
          {mlMeta && (
            <div className="flex flex-wrap items-center gap-1.5 px-5 pb-1.5">
              {mlMeta.mlScore != null && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium font-mono tabular-nums",
                    mlMeta.mlScore >= 0.6
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : mlMeta.mlScore >= 0.4
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                        : "border-red-500/30 bg-red-500/10 text-red-400",
                  )}
                >
                  <span className="text-white/40">ML</span>
                  {mlMeta.mlScore.toFixed(3)}
                </span>
              )}
              {mlMeta.kellyRaw != null && (
                <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium font-mono tabular-nums text-white/60">
                  <span className="text-white/40">Kelly</span>
                  {(mlMeta.kellyRaw * 100).toFixed(2)}%
                </span>
              )}
              {mlMeta.mlMultiplier != null &&
                (() => {
                  const m = mlMeta.mlMultiplier!;
                  const decision =
                    m < 0.1
                      ? "Skip"
                      : m < 0.95
                        ? "Shrink"
                        : m > 1.05
                          ? "Boost"
                          : "Agree";
                  const icon =
                    m < 0.1 ? "✕" : m < 0.95 ? "↓" : m > 1.05 ? "↑" : "≈";
                  const cls =
                    m < 0.1
                      ? "border-red-500/30 bg-red-500/10 text-red-400"
                      : m < 0.95
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                        : m > 1.05
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : "border-white/[0.08] bg-white/[0.04] text-white/50";
                  return (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium",
                        cls,
                      )}
                    >
                      <span>{icon}</span>
                      <span>{decision}</span>
                      <span className="font-mono tabular-nums">
                        ×{m.toFixed(3)}
                      </span>
                    </span>
                  );
                })()}
              {mlMeta.evPct != null && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium font-mono tabular-nums",
                    mlMeta.evPct >= 5
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : mlMeta.evPct >= 2
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                        : "border-white/[0.08] bg-white/[0.04] text-white/50",
                  )}
                >
                  <span className="text-white/40">EV</span>
                  {mlMeta.evPct > 0 ? "+" : ""}
                  {mlMeta.evPct.toFixed(2)}%
                </span>
              )}
            </div>
          )}

          {/* ── Legend row ── */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-5 pt-1 pb-3">
            {Object.entries(dataMap).map(([providerId]) => {
              const labelColor = getProviderChartHex(providerId);
              const hidden = hiddenProviders.has(providerId);
              return (
                <Tooltip key={providerId}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-1.5 cursor-pointer select-none transition-all duration-300 ease-out",
                        "rounded-full px-2.5 py-0.5 border",
                        hidden
                          ? "opacity-40 bg-transparent border-white/[0.05]"
                          : "opacity-100 bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.06] shadow-sm",
                      )}
                      onClick={() => toggleProvider(providerId)}
                    >
                      <span
                        className={cn(
                          "inline-block w-2 h-2 rounded-full shrink-0 ring-1 ring-black/20 shadow-sm transition-transform duration-300",
                          !hidden && "scale-110",
                        )}
                        style={{ backgroundColor: labelColor }}
                      />
                      <span
                        className={cn(
                          "text-[11px] font-medium transition-colors duration-300",
                          hidden
                            ? "text-white/30 line-through"
                            : "text-white/80",
                        )}
                      >
                        {getProviderShortName(providerId)}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className="text-xs bg-slate-900 border-white/10"
                  >
                    {hidden ? "Show" : "Hide"}{" "}
                    {getProviderShortName(providerId)}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>

        {/* ── Main body — chart + provider stats ── */}
        <div className="flex-1 flex flex-col min-w-0 bg-[#0c0e14]">
          {/* Chart container */}
          <div className="shrink-0 px-4 pt-4 pb-6 relative flex flex-col">
            <div className="absolute inset-x-4 top-4 bottom-2 rounded-xl border border-white/[0.03] bg-gradient-to-b from-white/[0.02] to-transparent pointer-events-none" />
            <div
              ref={chartContainerRef}
              className="w-full shrink-0"
              style={{ height: chartHeight }}
            />
          </div>

          {/* Stats table — Premium list */}
          <div className="shrink-0 border-t border-white/[0.05] bg-black/20 p-4">
            <div className="grid grid-cols-[1.5fr_repeat(4,_1fr)] gap-4 px-4 py-2 text-[10px] text-white/30 font-semibold uppercase tracking-widest rounded-t-xl bg-white/[0.02]">
              <span>Provider</span>
              <span className="text-right">Latest</span>
              <span className="text-right">Change</span>
              <span className="text-right">Peak</span>
              <span className="text-right">Trough</span>
            </div>

            <div className="flex flex-col gap-1 mt-1">
              {Object.entries(dataMap).map(([providerId, providerData]) => {
                if (!providerData || providerData.sparkline.length < 2)
                  return null;
                const labelColor = getProviderChartHex(providerId);
                const { last: pLast, changePct: pChangePct } =
                  computeProviderStats(providerData);
                const pDirColor =
                  pChangePct > 0.01
                    ? "text-emerald-400"
                    : pChangePct < -0.01
                      ? "text-rose-400"
                      : "text-white/40";
                const pDirArrow =
                  pChangePct > 0.01 ? "↗" : pChangePct < -0.01 ? "↘" : "→";

                return (
                  <div
                    key={providerId}
                    className="grid grid-cols-[1.5fr_repeat(4,_1fr)] gap-4 px-4 py-1.5 items-center rounded-lg border border-transparent hover:border-white/[0.06] hover:bg-white/[0.03] transition-all duration-200 group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div className="relative flex items-center justify-center size-5 rounded-full bg-black/40 ring-1 ring-white/10 shadow-inner">
                        <span
                          className="inline-block w-2 h-2 rounded-full"
                          style={{
                            backgroundColor: labelColor,
                            boxShadow: `0 0 8px ${labelColor}`,
                          }}
                        />
                      </div>
                      <span className="text-white/80 font-medium text-[11px] tracking-wide">
                        {getProviderShortName(providerId)}
                      </span>
                    </div>
                    <span className="text-right font-mono text-xs font-semibold text-white/90">
                      {pLast?.toFixed(3) ?? "–"}
                    </span>
                    <span
                      className={cn(
                        "text-right font-mono text-[11px] font-semibold flex items-center justify-end gap-1",
                        pDirColor,
                      )}
                    >
                      <span className="opacity-80 text-xs">{pDirArrow}</span>
                      <span>
                        {pChangePct > 0 ? "+" : ""}
                        {pChangePct.toFixed(2)}%
                      </span>
                    </span>
                    <span className="text-right font-mono text-[11px] text-white/40 group-hover:text-emerald-400/80 transition-colors duration-200">
                      {providerData.peakOdds?.toFixed(3) ?? "–"}
                    </span>
                    <span className="text-right font-mono text-[11px] text-white/40 group-hover:text-rose-400/80 transition-colors duration-200">
                      {providerData.troughOdds?.toFixed(3) ?? "–"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Right Column: Features Bento Grid ── */}
      {hasFeatures && featureGroups && (
        <div className="w-[300px] absolute right-0 top-0 bottom-0 overflow-y-auto overflow-x-hidden p-4 pt-12 bg-black/20 custom-scrollbar border-l border-white/[0.05]">
          <div className="text-[11px] font-semibold text-white/30 uppercase tracking-widest mb-3 px-1 flex items-center gap-1.5">
            <Sparkles className="size-3" />
            Machine Learning Analysis
          </div>
          <div className="flex flex-col gap-3 pb-3">
            {Array.from(featureGroups.entries()).map(([cat, items]) => (
              <div
                key={cat}
                className={cn(
                  "group relative rounded-xl border p-3 transition-all duration-300",
                  "bg-gradient-to-br bg-white/[0.02] backdrop-blur-md",
                  CAT_ACCENT[cat],
                  CAT_GLOW[cat],
                )}
              >
                {/* Category header */}
                <div className="flex items-center gap-2 mb-2.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full shrink-0 ring-4 ring-black/20",
                      CATEGORY_COLORS[cat],
                    )}
                  />
                  <span
                    className={cn(
                      "text-[10px] font-bold uppercase tracking-widest",
                      CATEGORY_TEXT_COLORS[cat],
                      "opacity-80",
                    )}
                  >
                    {cat}
                  </span>
                </div>

                {/* Feature rows - Bento style */}
                <div className="flex flex-col gap-1">
                  {items.map(({ meta, value }) => (
                    <Tooltip key={meta.name}>
                      <TooltipTrigger asChild>
                        <div className="flex items-center justify-between gap-3 px-2 py-1 -mx-2 rounded-md cursor-help transition-all duration-200 hover:bg-white/[0.06] hover:shadow-sm">
                          <span className="text-[11px] text-white/50 group-hover:text-white/80 transition-colors truncate">
                            {meta.label}
                          </span>
                          <span className="inline-flex items-center justify-center px-1.5 py-0.5 rounded text-[11px] font-medium font-mono text-white/80 bg-black/40 ring-1 ring-white/10 shadow-inner group-hover:ring-white/20 transition-all">
                            {formatFeatureValue(value, meta.fmt)}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent
                        side="left"
                        className="max-w-[240px] p-2.5 text-sm leading-relaxed bg-slate-900 border-white/10 shadow-xl"
                      >
                        <div className="font-semibold text-white/90 mb-0.5 text-xs">
                          {meta.label}
                        </div>
                        <div className="text-white/60 text-[11px] mb-2 leading-tight">
                          {meta.desc}
                        </div>
                        <div className="inline-block px-1.5 py-0.5 rounded bg-black/50 text-[10px] text-white/40 font-mono ring-1 ring-white/5">
                          {meta.name} = {value}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
