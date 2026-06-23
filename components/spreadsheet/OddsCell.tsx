"use client";


import { memo } from "react";
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
  onMovementClick?: () => void;
  onOpenMovementModal?: () => void;
  sharpRef?: { sparkline: [number, number][]; label: string };
}

const DIRECTION_THRESHOLD = 0.5;
function OddsCellInner({
  odds,
  onClick,
  providerLabel,
  onMovementClick,
  onOpenMovementModal,
  sharpRef,
}: OddsCellProps) {
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

  const showArrow =
    movement &&
    Math.abs(movement.changePct) >= DIRECTION_THRESHOLD &&
    movement.direction !== "stable";

  const steam = movement?.steamMove;

  const flashDir =
    showArrow && movement.direction === "up"
      ? "up"
      : showArrow && movement.direction === "down"
        ? "down"
        : null;

  const flashClass =
    flashDir === "up"
      ? "animate-flash-green"
      : flashDir === "down"
        ? "animate-flash-red"
        : "";

  const cell = (
    <td
      key={`${providerLabel ?? "odds"}-${odds.value}`}
      onClick={
        clickable
          ? onClick
          : onMovementClick
            ? () => onMovementClick()
            : undefined
      }
      className={`text-center px-2 font-mono text-[11px] tabular-nums relative transition-colors ${
        isSuspended
          ? "text-muted-foreground/60"
          : isBest
            ? "font-bold text-green-400 bg-green-900/10"
            : "text-foreground"
      } ${clickable ? "cursor-pointer hover:bg-emerald-500/15 hover:ring-1 hover:ring-emerald-500/40" : onMovementClick ? "cursor-pointer hover:bg-muted/60" : ""} ${flashClass}`}
    >
      <div className="flex items-center justify-center gap-0.5">
        {showArrow && !isSuspended && (
          <span
            className={`text-[8px] leading-none ${
              movement.direction === "up" ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {movement.direction === "up" ? "▲" : "▼"}
          </span>
        )}

        <span className={isSuspended ? "opacity-60" : ""}>
          {odds.value.toFixed(2)}
        </span>

        {!isSuspended && isBest && !steam && (
          <span className="text-[9px] text-green-400">*</span>
        )}

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
            onClickFullChart={onOpenMovementModal}
            sharpRef={sharpRef}
          />
        </TooltipContent>
      </Tooltip>
    );
  }

  return cell;
}

export const OddsCell = memo(OddsCellInner);
