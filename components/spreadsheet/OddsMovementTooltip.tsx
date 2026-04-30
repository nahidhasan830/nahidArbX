"use client";

import { useState } from "react";
import { Sparkline } from "@/components/ui/sparkline";

// ─── Common shape for movement data ──────────────────────────────────────────
// Works with both:
//   - AtomOddsData["movement"] (live, from ValueBetSpreadsheet)
//   - OddsMovementData          (persisted, from BetsHistoryTable)

export interface MovementTooltipData {
  sparkline: [number, number][];
  openingOdds: number | null;
  peakOdds: number;
  troughOdds: number;
  totalTicks: number;
  /** Live-only fields */
  direction?: "up" | "down" | "stable";
  changePct?: number;
  steamMove?: {
    direction: "up" | "down";
    magnitudePct: number;
    significance: "weak" | "moderate" | "strong";
  } | null;
}

interface OddsMovementTooltipContentProps {
  movement: MovementTooltipData;
  /** Header label — e.g. "Price Movement" or "Pinnacle" */
  label?: string;
  /** Current odds value (used to compute total change when changePct isn't pre-computed) */
  currentOdds?: number;
  /** Fires when the user clicks "Click for full chart" — opens the detail modal. */
  onClickFullChart?: () => void;
  /** Sharp provider sparkline as a reference overlay (soft provider tooltips only). */
  sharpRef?: {
    sparkline: [number, number][];
    label: string;
  };
}

/**
 * Unified movement tooltip content used by both BetsHistoryTable and
 * ValueBetSpreadsheet. Renders inside a zero-padding `<TooltipContent>`.
 *
 * Layout:
 *   Header  │  Price Movement    ▲ +3.42%
 *   Chart   │  [sparkline 200×36]
 *   Stats   │  Open → Last   5.55 → 5.74
 *           │  Peak / Trough 5.74 / 5.29
 *           │  Click for full chart
 */
export function OddsMovementTooltipContent({
  movement: m,
  label = "Price Movement",
  currentOdds,
  onClickFullChart,
  sharpRef,
}: OddsMovementTooltipContentProps) {
  // We can't call Date.now() during render (impure), so we track a stable
  // "now" timestamp via ref/effect. The tooltip only shows while hovering,
  // so a ~1s lag is acceptable.
  const [now] = useState(() => Date.now());


  if (m.totalTicks < 2 || m.sparkline.length < 2) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground">
        {label}: not enough data
      </div>
    );
  }

  // Compute % change — prefer pre-computed, fall back to sparkline endpoints
  const first = m.sparkline[0][1];
  const last = currentOdds ?? m.sparkline[m.sparkline.length - 1][1];
  const changePct =
    m.changePct ??
    (first !== 0
      ? Math.round(((last - first) / first) * 10000) / 100
      : 0);

  const isUp = changePct > 0.01;
  const isDown = changePct < -0.01;
  const dirColor = isUp
    ? "text-emerald-400"
    : isDown
      ? "text-red-400"
      : "text-muted-foreground";
  const dirArrow = isUp ? "▲" : isDown ? "▼" : "";

  // Freshness — compute from last sparkline timestamp.
  // Use a stable "now" from when the component last received props (the
  // sparkline data itself carries timestamps, so staleness is bounded by
  // the polling interval).
  const lastTs = m.sparkline[m.sparkline.length - 1][0];
  // Approximate age using the fact that sparkline timestamps are epoch ms.
  const ageSec = lastTs > 1e12 ? Math.round((now - lastTs) / 1000) : 0;
  const ageLabel =
    ageSec > 0
      ? ageSec < 60
        ? `${ageSec}s ago`
        : ageSec < 3600
          ? `${Math.round(ageSec / 60)}m ago`
          : `${Math.round(ageSec / 3600)}h ago`
      : null;

  return (
    <div className="flex flex-col w-[220px]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1">
        <span className="text-[11px] font-medium text-foreground">
          {label}
        </span>
        <span
          className={`text-[11px] font-mono font-semibold tabular-nums ${dirColor}`}
        >
          {dirArrow && <span className="text-[9px] mr-0.5 inline-block -translate-y-px">{dirArrow}</span>} {changePct > 0 ? "+" : ""}
          {changePct.toFixed(2)}%
        </span>
      </div>

      {/* Sparkline */}
      <div className="px-2.5 pb-1">
        <Sparkline
          data={m.sparkline}
          width={200}
          height={36}
          className="w-full"
          referenceData={sharpRef?.sparkline}
        />
      </div>

      {/* Stats */}
      <div className="flex flex-col gap-0.5 px-3 pb-2 pt-1 border-t border-border/40">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Open → Last</span>
          <span className="font-mono tabular-nums">
            {m.openingOdds?.toFixed(2) ?? "–"} → {last.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Peak / Trough</span>
          <span className="font-mono tabular-nums">
            <span className="text-emerald-400">{m.peakOdds.toFixed(2)}</span>
            {" / "}
            <span className="text-red-400">{m.troughOdds.toFixed(2)}</span>
          </span>
        </div>

        {/* Sharp reference context line */}
        {sharpRef && sharpRef.sparkline.length >= 2 && (() => {
          const sFirst = sharpRef.sparkline[0][1];
          const sLast = sharpRef.sparkline[sharpRef.sparkline.length - 1][1];
          return (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{sharpRef.label} ref</span>
              <span className="font-mono tabular-nums text-muted-foreground/80">
                {sFirst.toFixed(2)} → {sLast.toFixed(2)}
              </span>
            </div>
          );
        })()}

        {/* Ticks + freshness (live) */}
        {(m.totalTicks > 0 || ageLabel) && (
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{m.totalTicks} ticks</span>
            {ageLabel && <span>{ageLabel}</span>}
          </div>
        )}

        {/* Steam move alert (live only) */}
        {m.steamMove && (
          <div
            className={`flex items-center gap-1 text-[11px] font-medium rounded px-1.5 py-0.5 mt-0.5 ${
              m.steamMove.significance === "strong"
                ? "bg-red-500/15 text-red-400"
                : m.steamMove.significance === "moderate"
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            <span>🔥</span>
            <span>
              Steam {m.steamMove.direction === "up" ? "↑" : "↓"}{" "}
              {m.steamMove.magnitudePct.toFixed(1)}% (
              {m.steamMove.significance})
            </span>
          </div>
        )}

        <button
          type="button"
          className="flex items-center justify-center pt-1 text-[10px] text-muted-foreground/70 hover:text-foreground transition-colors w-full cursor-pointer"
          onClick={(e) => {
            if (onClickFullChart) {
              e.stopPropagation();
              onClickFullChart();
            }
          }}
        >
          Click for full chart
        </button>
      </div>
    </div>
  );
}
