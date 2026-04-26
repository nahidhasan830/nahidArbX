"use client";

/**
 * Dropdown pill that lets the user pick one or more promoted strategies
 * and apply their filters as a toolbar template. Shown in both the
 * value-bet and bets-history spreadsheet toolbars.
 */

import * as React from "react";
import { ChevronDown, Zap } from "lucide-react";
import { useApplicableStrategies } from "@/lib/optimizer/use-live-strategies";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

interface StrategyPickerPillProps {
  appliedStrategyIds: string[];
  onApply: (ids: string[]) => void;
  isModified: boolean;
}

export function StrategyPickerPill({
  appliedStrategyIds,
  onApply,
  isModified,
}: StrategyPickerPillProps) {
  const { data: strategies } = useApplicableStrategies();
  const list = strategies ?? [];
  const [open, setOpen] = React.useState(false);
  const selected = new Set(appliedStrategyIds);
  const hasSelection = appliedStrategyIds.length > 0;

  if (list.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onApply([...next]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "h-7 px-2 text-[11px] gap-1 font-normal",
            hasSelection && !isModified && "text-cyan-700 dark:text-cyan-300",
            hasSelection && isModified && "text-amber-700 dark:text-amber-400",
          )}
        >
          <Zap className="size-3" />
          {hasSelection
            ? `${appliedStrategyIds.length} strateg${appliedStrategyIds.length === 1 ? "y" : "ies"}`
            : "Strategy"}
          <ChevronDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <div className="max-h-48 overflow-y-auto">
          {list.map((s) => (
            <label
              key={s.id}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-muted/60 cursor-pointer text-[11px]"
            >
              <Checkbox
                checked={selected.has(s.id)}
                onCheckedChange={() => toggle(s.id)}
              />
              <span className="truncate">{s.name}</span>
            </label>
          ))}
        </div>
        {hasSelection && (
          <div className="border-t border-border/60 mt-1 pt-1 px-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-6 text-[10px] text-muted-foreground"
              onClick={() => {
                onApply([]);
                setOpen(false);
              }}
            >
              Clear selection
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
