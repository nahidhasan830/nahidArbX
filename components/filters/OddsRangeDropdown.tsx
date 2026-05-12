/**
 * OddsRangeDropdown — reusable filter for soft-odds min/max.
 *
 * Used in both BetsHistoryToolbar and SpreadsheetToolbar.
 * Uses a dual-thumb range slider — compact and precise.
 *
 * `min` / `max` = undefined means "no constraint on that bound".
 */

"use client";

import { useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TriggerBadge } from "./TriggerBadge";

// Slider bounds
const ODDS_MIN = 1.01;
const ODDS_MAX = 20.0;
const ODDS_STEP = 0.25;

// Snap to edges = "no constraint"
function toSlider(val: number | undefined, edge: number): number {
  return val ?? edge;
}

function fromSlider(val: number, edge: number): number | undefined {
  return Math.abs(val - edge) < 0.001 ? undefined : val;
}

function badgeLabel(min?: number, max?: number): string {
  if (min == null && max == null) return "All";
  if (min != null && max != null) return `${min.toFixed(2)}–${max.toFixed(2)}`;
  if (min != null) return `≥${min.toFixed(2)}`;
  return `≤${max!.toFixed(2)}`;
}

const BTN_BASE = "h-7 px-2 text-[11px] gap-1.5 font-normal";

export interface OddsRangeDropdownProps {
  min?: number;
  max?: number;
  onChange: (min: number | undefined, max: number | undefined) => void;
  label?: string;
  align?: "start" | "end" | "center";
  className?: string;
}

export function OddsRangeDropdown({
  min,
  max,
  onChange,
  label = "Odds",
  align = "start",
  className,
}: OddsRangeDropdownProps) {
  const isActive = min != null || max != null;

  const value: [number, number] = [
    toSlider(min, ODDS_MIN),
    toSlider(max, ODDS_MAX),
  ];

  const handleCommit = useCallback(
    ([lo, hi]: number[]) => {
      onChange(fromSlider(lo, ODDS_MIN), fromSlider(hi, ODDS_MAX));
    },
    [onChange],
  );

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn(BTN_BASE, className)}>
          {label}
          <TriggerBadge active={isActive}>{badgeLabel(min, max)}</TriggerBadge>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="p-3 w-64"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Soft odds range
          </span>
          {isActive && (
            <button
              type="button"
              onClick={() => {
                onChange(undefined, undefined);
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <Slider
          min={ODDS_MIN}
          max={ODDS_MAX}
          step={ODDS_STEP}
          value={value}
          onValueChange={handleCommit}
          onValueCommit={handleCommit}
          className="mb-2"
        />
        <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>
            {fromSlider(value[0], ODDS_MIN) == null
              ? "Min"
              : value[0].toFixed(2)}
          </span>
          <span>
            {fromSlider(value[1], ODDS_MAX) == null
              ? "Max"
              : value[1].toFixed(2)}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
