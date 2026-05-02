"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { format } from "date-fns";
import type { OddsMovementData } from "@/lib/bets-history/types";
import { getProviderShortName, getProviderChartHex, isSharpProvider } from "@/lib/providers/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MovementDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: Record<string, OddsMovementData> | OddsMovementData | null;
  /** E.g. "Liverpool vs Arsenal" */
  eventLabel: string;
  /** E.g. "Match Result · Home Win" */
  marketLabel: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeProviderStats(d: OddsMovementData) {
  const vals = d.sparkline.map((s) => s[1]);
  const first = vals[0];
  const last = vals[vals.length - 1];
  const changePct =
    first !== 0
      ? Math.round(((last - first) / first) * 10000) / 100
      : 0;
  return { first, last, changePct };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function MovementDetailModal({
  open,
  onOpenChange,
  data,
  eventLabel,
  marketLabel,
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
  const sharpProviderId = providers.find(p => isSharpProvider(p)) || providers[0];
  const sharpData = dataMap[sharpProviderId];
  if (!sharpData || sharpData.sparkline.length < 2) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[680px] p-0 gap-0 overflow-hidden">
        <ModalInner
          dataMap={dataMap}
          sharpProviderId={sharpProviderId}
          eventLabel={eventLabel}
          marketLabel={marketLabel}
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
}: {
  dataMap: Record<string, OddsMovementData>;
  sharpProviderId: string;
  eventLabel: string;
  marketLabel: string;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<
    typeof import("lightweight-charts").createChart
  > | null>(null);
  const seriesMapRef = useRef<Record<string, import("lightweight-charts").ISeriesApi<"Area" | "Line">>>({});
  
  const [hiddenProviders, setHiddenProviders] = useState<Set<string>>(new Set());

  const toggleProvider = (id: string) => {
    setHiddenProviders(prev => {
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
  const { last: sharpLast, changePct: sharpChangePct } = computeProviderStats(sharpData);

  const isUp = sharpChangePct > 0.01;
  const isDown = sharpChangePct < -0.01;
  const sharpLineColor = isUp
    ? "rgba(34, 197, 94, 1)"
    : isDown
      ? "rgba(239, 68, 68, 1)"
      : "rgba(148, 163, 184, 1)";
  const topGradient = isUp
    ? "rgba(34, 197, 94, 0.18)"
    : isDown
      ? "rgba(239, 68, 68, 0.18)"
      : "rgba(148, 163, 184, 0.08)";
  const bottomColor = "rgba(0, 0, 0, 0)";


  const providerCount = Object.keys(dataMap).length;

  // Initialize lightweight-charts
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    let isCancelled = false;
    let chart: ReturnType<typeof import("lightweight-charts").createChart> | null = null;

    // Dynamic import to keep the module lazy
    import("lightweight-charts").then(({ createChart, AreaSeries, LineSeries, ColorType, CrosshairMode, LineStyle }) => {
      // Prevent double-render in StrictMode if component unmounted before import resolved
      if (isCancelled || !container.isConnected) return;

      chart = createChart(container, {
        autoSize: true,
        height: 240,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "rgba(148, 163, 184, 0.6)",
          fontFamily: "var(--font-mono), ui-monospace, monospace",
          fontSize: 10,
          attributionLogo: false,
        },
        grid: {
          // Hide vertical grid lines for a cleaner look
          vertLines: { visible: false },
          horzLines: { color: "rgba(148, 163, 184, 0.08)", style: LineStyle.Dashed },
        },
        crosshair: {
          mode: CrosshairMode.Magnet,
          vertLine: {
            color: "rgba(148, 163, 184, 0.4)",
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: "rgba(15, 23, 42, 0.95)", // slate-900
          },
          horzLine: {
            color: "rgba(148, 163, 184, 0.4)",
            width: 1,
            style: LineStyle.Solid,
            labelBackgroundColor: "rgba(15, 23, 42, 0.95)",
          },
        },
        rightPriceScale: {
          borderVisible: false,
          scaleMargins: { top: 0.12, bottom: 0.12 },
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
          // Primary sharp line gets an AreaSeries with dynamic up/down color
          const series = chart.addSeries(AreaSeries, {
            lineColor: sharpLineColor,
            topColor: topGradient,
            bottomColor,
            lineWidth: 2,
            crosshairMarkerRadius: 5,
            crosshairMarkerBorderColor: "rgba(15, 23, 42, 1)",
            crosshairMarkerBorderWidth: 2,
            crosshairMarkerBackgroundColor: sharpLineColor,
            priceFormat: { type: "price", precision: 3, minMove: 0.001 },
          });
          series.setData(chartData);
          seriesMapRef.current[providerId] = series;
        } else {
          // Soft providers get a simple LineSeries with their brand color
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
    });

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

  return (
    <>
      {/* Header */}
      <DialogHeader className="px-5 pt-5 pb-1">
        <DialogTitle className="text-sm font-semibold leading-snug pr-6">
          {eventLabel}
        </DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground mt-0.5">
          {marketLabel} · {sharpData.totalTicks} ticks
        </DialogDescription>
      </DialogHeader>

      {/* Legend — minimal toggles: dot + name only */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-2 pb-3 border-b border-border/30">
        {Object.entries(dataMap).map(([providerId]) => {
          const isSharp = providerId === sharpProviderId;
          const labelColor = isSharp ? sharpLineColor : getProviderChartHex(providerId);
          return (
            <button
              type="button"
              key={providerId}
              className={`flex items-center gap-1.5 cursor-pointer select-none transition-opacity hover:opacity-80 ${hiddenProviders.has(providerId) ? 'opacity-30 line-through' : 'opacity-100'}`}
              onClick={() => toggleProvider(providerId)}
            >
              <span
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: labelColor }}
              />
              <span className="text-[11px] font-medium text-foreground/80">
                {getProviderShortName(providerId)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Chart — lightweight-charts canvas */}
      <div
        ref={chartContainerRef}
        className="px-1 pb-1 pt-2"
        style={{ minHeight: 240 }}
      />

      {/* Footer — stats table (always per-provider rows) */}
      <div className="border-t border-border/40">
        {/* Column headers */}
        <div className="grid grid-cols-[1fr_repeat(5,_minmax(0,1fr))] px-4 py-1.5 bg-muted/30 text-[10px] text-muted-foreground font-medium">
          <span>Provider</span>
          <span className="text-right">Opening</span>
          <span className="text-right">Latest</span>
          <span className="text-right">Change</span>
          <span className="text-right">Peak</span>
          <span className="text-right">Trough</span>
        </div>
        {Object.entries(dataMap).map(([providerId, providerData]) => {
          const isSharp = providerId === sharpProviderId;
          const labelColor = isSharp ? sharpLineColor : getProviderChartHex(providerId);
          const { last: pLast, changePct: pChangePct } = computeProviderStats(providerData);
          const pDirColor = pChangePct > 0.01 ? "text-emerald-400" : pChangePct < -0.01 ? "text-red-400" : "text-muted-foreground";
          const pDirArrow = pChangePct > 0.01 ? "▲" : pChangePct < -0.01 ? "▼" : "";
          return (
            <div
              key={providerId}
              className="grid grid-cols-[1fr_repeat(5,_minmax(0,1fr))] px-4 py-1.5 border-t border-border/20 text-[11px] font-mono tabular-nums"
            >
              <span className="flex items-center gap-1.5 text-foreground/80 font-sans text-[11px]">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: labelColor }}
                />
                {getProviderShortName(providerId)}
              </span>
              <span className="text-right text-foreground">
                {providerData.openingOdds?.toFixed(3) ?? "–"}
              </span>
              <span className="text-right font-medium text-foreground">
                {pLast.toFixed(3)}
              </span>
              <span className={`text-right font-medium ${pDirColor}`}>
                {pDirArrow && <span className="text-[8px] mr-0.5">{pDirArrow}</span>}
                {pChangePct > 0 ? "+" : ""}{pChangePct.toFixed(2)}%
              </span>
              <span className="text-right text-emerald-400">
                {providerData.peakOdds.toFixed(3)}
              </span>
              <span className="text-right text-red-400">
                {providerData.troughOdds.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

