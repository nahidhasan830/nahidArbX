"use client";

/**
 * Single provider-odds cell for the value-bets spreadsheet.
 *
 * Renders one price with:
 * - Direction arrow (▲/▼) colored by movement direction
 * - Flash animation on significant price change (>0.5%)
 * - Steam move badge (🔥) for sharp line movements
 * - Rich movement tooltip on hover (opening→current, sparkline, peak/trough)
 *
 * The reactive engine polls every 1.5s so odds in the backend store are
 * always fresh. Movement data is populated from the in-memory ring buffer.
 */

import { useRef, useEffect, useState, memo } from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { OddsMovementTooltipContent } from "./OddsMovementTooltip";
import type { AtomOddsData } from "@/lib/formatting/spreadsheet";

interface OddsCellProps {
  odds: AtomOddsData | null | undefined;
  onClick?: () => void;
  providerLabel?: string;
  /** Fires when user clicks a cell with movement data — opens the full chart modal. */
  onMovementClick?: (movement: NonNullable<AtomOddsData["movement"]>) => void;
}

/** Threshold (%) below which we don't show direction arrow / flash. */
const DIRECTION_THRESHOLD = 0.5;
/** Flash animation duration in ms. */
const FLASH_DURATION_MS = 600;

function OddsCellInner({ odds, onClick, providerLabel, onMovementClick }: OddsCellProps) {
  // Flash state: briefly highlight cell on significant price change
  const prevValueRef = useRef(odds?.value ?? 0);
  const [flashDir, setFlashDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (!odds) return;
    const prev = prevValueRef.current;
    prevValueRef.current = odds.value;
    if (prev === odds.value) return;

    const pctChange =
      prev !== 0
        ? Math.abs(((odds.value - prev) / prev) * 100)
        : 0;
    if (pctChange < DIRECTION_THRESHOLD) return;

    setFlashDir(odds.value > prev ? "up" : "down");
    const timer = setTimeout(() => setFlashDir(null), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [odds?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!odds) {
    return (
      <td className="text-center px-2 text-muted-foreground/40 font-mono text-[11px] tabular-nums">
        -
      </td>
    );
  }

  const isBest = odds.isBest;
  const isSuspended = odds.suspended;
  const clickable = Boolean(onClick) && !isSuspended;
  const movement = odds.movement;

  // Direction arrow: only show when movement exceeds threshold
  const showArrow =
    movement &&
    Math.abs(movement.changePct) >= DIRECTION_THRESHOLD &&
    movement.direction !== "stable";

  // Steam move badge
  const steam = movement?.steamMove;

  // Flash background class
  const flashClass =
    flashDir === "up"
      ? "animate-flash-green"
      : flashDir === "down"
        ? "animate-flash-red"
        : "";

  const cell = (
    <td
      onClick={clickable ? onClick : onMovementClick && movement && movement.totalTicks >= 2 ? () => onMovementClick(movement) : undefined}
      className={`text-center px-2 font-mono text-[11px] tabular-nums relative transition-colors ${
        isSuspended
          ? "text-muted-foreground/60"
          : isBest
            ? "font-bold text-green-400 bg-green-900/10"
            : "text-foreground"
      } ${clickable ? "cursor-pointer hover:bg-emerald-500/15 hover:ring-1 hover:ring-emerald-500/40" : onMovementClick && movement && movement.totalTicks >= 2 ? "cursor-pointer hover:bg-muted/60" : ""} ${flashClass}`}
    >
      <div className="flex items-center justify-center gap-0.5">
        {/* Direction arrow */}
        {showArrow && !isSuspended && (
          <span
            className={`text-[8px] leading-none ${
              movement.direction === "up"
                ? "text-emerald-400"
                : "text-red-400"
            }`}
          >
            {movement.direction === "up" ? "▲" : "▼"}
          </span>
        )}

        {/* Price */}
        <span className={isSuspended ? "opacity-60" : ""}>
          {odds.value.toFixed(2)}
        </span>

        {/* Best odds marker */}
        {!isSuspended && isBest && !steam && (
          <span className="text-[9px] text-green-400">*</span>
        )}

        {/* Steam move badge */}
        {!isSuspended && steam && (
          <span
            className={`text-[8px] leading-none ${
              steam.significance === "strong"
                ? "text-red-400 animate-pulse"
                : steam.significance === "moderate"
                  ? "text-amber-400"
                  : "text-muted-foreground"
            }`}
            title={`Steam ${steam.direction === "up" ? "↑" : "↓"} ${steam.magnitudePct.toFixed(1)}%`}
          >
            🔥
          </span>
        )}
      </div>

      {/* Suspended overlay */}
      {isSuspended && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-yellow-900/40"
          title="Market suspended - not available for betting"
        >
          <span className="text-[8px] font-bold uppercase text-yellow-400 tracking-wider">
            Suspended
          </span>
        </div>
      )}
    </td>
  );

  // Wrap in tooltip only when we have meaningful movement data
  if (movement && movement.totalTicks >= 2 && !isSuspended) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{cell}</TooltipTrigger>
        <TooltipContent
          side="top"
          className="p-0 overflow-hidden rounded-lg border border-border/60"
          sideOffset={6}
        >
          <OddsMovementTooltipContent
            movement={movement}
            label={providerLabel ?? "Provider"}
            currentOdds={odds.value}
          />
        </TooltipContent>
      </Tooltip>
    );
  }

  return cell;
}

export const OddsCell = memo(OddsCellInner);
