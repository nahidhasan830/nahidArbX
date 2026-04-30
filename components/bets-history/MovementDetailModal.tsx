"use client";

import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { OddsMovementData } from "@/lib/bets-history/types";
import { getProviderShortName } from "@/lib/providers/registry";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MovementDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OddsMovementData | null;
  /** E.g. "Liverpool vs Arsenal" */
  eventLabel: string;
  /** E.g. "Match Result · Home Win" */
  marketLabel: string;
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
  if (!open || !data || data.sparkline.length < 2) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px] p-0 gap-0 overflow-hidden">
        <ModalInner
          data={data}
          eventLabel={eventLabel}
          marketLabel={marketLabel}
        />
      </DialogContent>
    </Dialog>
  );
}

// ─── Inner content (only mounts when dialog is open) ────────────────────────

function ModalInner({
  data,
  eventLabel,
  marketLabel,
}: {
  data: OddsMovementData;
  eventLabel: string;
  marketLabel: string;
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<
    typeof import("lightweight-charts").createChart
  > | null>(null);

  const values = data.sparkline.map((s) => s[1]);
  const first = values[0];
  const last = values[values.length - 1];
  const totalChangePct =
    first !== 0
      ? Math.round(((last - first) / first) * 10000) / 100
      : 0;
  const isUp = totalChangePct > 0.01;
  const isDown = totalChangePct < -0.01;
  const lineColor = isUp
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

  const dirArrow = isUp ? "▲" : isDown ? "▼" : "";
  const dirTextClass = isUp
    ? "text-emerald-400"
    : isDown
      ? "text-red-400"
      : "text-muted-foreground";

  // Initialize lightweight-charts
  useEffect(() => {
    const container = chartContainerRef.current;
    if (!container) return;

    let isCancelled = false;
    let chart: ReturnType<typeof import("lightweight-charts").createChart> | null = null;

    // Dynamic import to keep the module lazy
    import("lightweight-charts").then(({ createChart, AreaSeries, ColorType, CrosshairMode, LineStyle }) => {
      // Prevent double-render in StrictMode if component unmounted before import resolved
      if (isCancelled || !container.isConnected) return;

      chart = createChart(container, {
        autoSize: true,
        height: 200,
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
          scaleMargins: { top: 0.15, bottom: 0.15 },
        },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          tickMarkFormatter: (time: number) => {
            const d = new Date(time * 1000);
            return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
          },
        },
        handleScroll: false,
        handleScale: false,
      });

      chartRef.current = chart;

      const series = chart.addSeries(AreaSeries, {
        lineColor,
        topColor: topGradient,
        bottomColor,
        lineWidth: 2,
        crosshairMarkerRadius: 5, // slightly larger marker
        crosshairMarkerBorderColor: "rgba(15, 23, 42, 1)", // dark background
        crosshairMarkerBorderWidth: 2,
        crosshairMarkerBackgroundColor: lineColor,
        priceFormat: { type: "price", precision: 3, minMove: 0.001 },
      });

      // Convert sparkline timestamps to lightweight-charts format
      const chartData = data.sparkline.map(([ts, value]) => ({
        time: Math.floor(ts / 1000) as import("lightweight-charts").UTCTimestamp,
        value,
      }));
      series.setData(chartData);

      // Add opening odds baseline marker
      if (data.openingOdds != null) {
        series.createPriceLine({
          price: data.openingOdds,
          color: "rgba(148, 163, 184, 0.4)", // slightly more visible
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "Open",
        });
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
  }, [data]);

  return (
    <>
      {/* Header */}
      <DialogHeader className="px-5 pt-5 pb-3">
        <DialogTitle className="text-sm font-semibold leading-snug">
          {eventLabel}
        </DialogTitle>
        <DialogDescription className="text-xs text-muted-foreground mt-0.5">
          {marketLabel} ·{" "}
          {data.provider
            ? getProviderShortName(data.provider)
            : "Sharp"}{" "}
          · {data.totalTicks} ticks
        </DialogDescription>
      </DialogHeader>

      {/* Summary strip */}
      <div className="flex items-center gap-4 px-5 pb-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Change</span>
          <span
            className={`text-sm font-mono font-semibold tabular-nums ${dirTextClass}`}
          >
            {dirArrow && <span className="text-[10px] mr-1 inline-block -translate-y-px">{dirArrow}</span>} {totalChangePct > 0 ? "+" : ""}
            {totalChangePct.toFixed(2)}%
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Open</span>
          <span className="text-sm font-mono tabular-nums">
            {data.openingOdds?.toFixed(2) ?? "–"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Current</span>
          <span className="text-sm font-mono tabular-nums font-medium">
            {last.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-emerald-400">Peak</span>
          <span className="text-sm font-mono tabular-nums text-emerald-400">
            {data.peakOdds.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-red-400">Trough</span>
          <span className="text-sm font-mono tabular-nums text-red-400">
            {data.troughOdds.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Chart — lightweight-charts canvas */}
      <div
        ref={chartContainerRef}
        className="pl-3 pr-5 pb-2"
        style={{ minHeight: 200 }}
      />

      {/* Footer stats */}
      <div className="grid grid-cols-4 gap-px bg-border/30 border-t border-border/40">
        <StatBox
          label="Opening"
          value={data.openingOdds?.toFixed(3) ?? "–"}
        />
        <StatBox
          label="Closing"
          value={last.toFixed(3)}
          className={dirTextClass}
        />
        <StatBox
          label="Peak"
          value={data.peakOdds.toFixed(3)}
          className="text-emerald-400"
        />
        <StatBox
          label="Trough"
          value={data.troughOdds.toFixed(3)}
          className="text-red-400"
        />
      </div>
    </>
  );
}

function StatBox({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col items-center py-2.5 bg-background">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span
        className={`text-sm font-mono font-semibold tabular-nums ${className ?? "text-foreground"}`}
      >
        {value}
      </span>
    </div>
  );
}
