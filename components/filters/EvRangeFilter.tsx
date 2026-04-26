/**
 * EvRangeFilter — shared EV% range filter dropdown with a range slider.
 *
 * Used in both BetsHistoryToolbar and SpreadsheetToolbar.
 * Snapping to the absolute edges means "no constraint" (undefined).
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TriggerBadge } from "./TriggerBadge";

// Slider bounds — cover realistic EV% range
const EV_MIN = -10;
const EV_MAX = 30;
const EV_STEP = 0.25;

function toSlider(val: number | undefined, edge: number): number {
  return val ?? edge;
}

function fromSlider(val: number, edge: number): number | undefined {
  return val === edge ? undefined : val;
}

function badgeLabel(min?: number, max?: number): string {
  if (min == null && max == null) return "All";
  if (min != null && max != null) return `${min}–${max}%`;
  if (min != null) return `≥${min}%`;
  return `≤${max}%`;
}

const BTN_BASE = cn("h-7 px-2 text-[11px] gap-1.5 font-normal");

interface EvRangeFilterProps {
  /** undefined = no constraint */
  min?: number;
  max?: number;
  onChange: (min: number | undefined, max: number | undefined) => void;
  align?: "start" | "end" | "center";
}

export function EvRangeFilter({
  min,
  max,
  onChange,
  align = "start",
}: EvRangeFilterProps) {
  const isActive = min != null || max != null;

  // Local state for smooth drag
  const [local, setLocal] = useState<[number, number]>([
    toSlider(min, EV_MIN),
    toSlider(max, EV_MAX),
  ]);

  // Sync from parent (e.g., after reset)
  const prevMin = useRef(min);
  const prevMax = useRef(max);
  useEffect(() => {
    if (prevMin.current !== min || prevMax.current !== max) {
      prevMin.current = min;
      prevMax.current = max;
      setLocal([toSlider(min, EV_MIN), toSlider(max, EV_MAX)]);
    }
  }, [min, max]);

  const handleCommit = useCallback(
    ([lo, hi]: number[]) => {
      onChange(fromSlider(lo, EV_MIN), fromSlider(hi, EV_MAX));
    },
    [onChange],
  );

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={BTN_BASE}>
          EV%
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
            EV % range
          </span>
          {isActive && (
            <button
              type="button"
              onClick={() => {
                setLocal([EV_MIN, EV_MAX]);
                onChange(undefined, undefined);
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <Slider
          min={EV_MIN}
          max={EV_MAX}
          step={EV_STEP}
          value={local}
          onValueChange={(v) => setLocal(v as [number, number])}
          onValueCommit={handleCommit}
          className="mb-2"
        />
        <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>
            {fromSlider(local[0], EV_MIN) == null ? "Min" : `${local[0]}%`}
          </span>
          <span>
            {fromSlider(local[1], EV_MAX) == null ? "Max" : `${local[1]}%`}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
