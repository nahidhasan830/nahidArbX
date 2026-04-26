"use client";

/**
 * Toolbar for the trials section on the run detail page.
 * Controls view mode (top-50 / Pareto / all) and unreliable-trial visibility.
 */

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export type TrialsViewMode = "top50" | "pareto" | "all";

interface TrialsToolbarProps {
  viewMode: TrialsViewMode;
  onViewModeChange: (mode: TrialsViewMode) => void;
  showUnreliable: boolean;
  onShowUnreliableChange: (show: boolean) => void;
  visibleCount: number;
  totalLoaded: number;
  hiddenUnreliableCount: number;
  onLoadAll: () => void;
}

const CTRL_H = "h-7";
const BTN_BASE = cn(CTRL_H, "px-2 text-[11px] gap-1.5 font-normal");

export function TrialsToolbar({
  viewMode,
  onViewModeChange,
  showUnreliable,
  onShowUnreliableChange,
  visibleCount,
  totalLoaded,
  hiddenUnreliableCount,
}: TrialsToolbarProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 bg-muted/30">
      <ToggleGroup
        type="single"
        value={viewMode}
        onValueChange={(v) => {
          if (v) onViewModeChange(v as TrialsViewMode);
        }}
        className="gap-0.5"
      >
        <ToggleGroupItem value="top50" className={BTN_BASE}>
          Top 50
        </ToggleGroupItem>
        <ToggleGroupItem value="pareto" className={BTN_BASE}>
          Pareto
        </ToggleGroupItem>
        <ToggleGroupItem value="all" className={BTN_BASE}>
          All
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="w-px h-4 bg-border shrink-0" />

      <label className="flex items-center gap-1.5 cursor-pointer">
        <Checkbox
          checked={showUnreliable}
          onCheckedChange={(v) => onShowUnreliableChange(v === true)}
          className="size-3.5"
        />
        <span className="text-[11px] text-muted-foreground">
          Show unreliable
          {hiddenUnreliableCount > 0 && !showUnreliable && (
            <span className="ml-1 tabular-nums">
              ({hiddenUnreliableCount} hidden)
            </span>
          )}
        </span>
      </label>

      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
        {visibleCount} / {totalLoaded}
      </span>
    </div>
  );
}
