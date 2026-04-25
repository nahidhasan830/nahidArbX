/**
 * MarketsFilter — shared strategy-relevant market type dropdown.
 *
 * Uses a curated 8-market list that maps 1:1 to strategy configs.
 * Both BetsHistoryToolbar and SpreadsheetToolbar import this.
 */

"use client";

import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TriggerBadge } from "./TriggerBadge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ── Strategy-relevant market options ──────────────────────────────────────────
// Keep in sync with strategy config market keys.
export const MARKET_OPTIONS: { value: string; label: string }[] = [
  { value: "MATCH_RESULT", label: "Match Result" },
  { value: "TOTAL_GOALS", label: "Total Goals" },
  { value: "BTTS", label: "BTTS" },
  { value: "ASIAN_HANDICAP", label: "Asian Handicap" },
  { value: "EUROPEAN_HANDICAP", label: "European Handicap" },
  { value: "DNB", label: "Draw No Bet" },
  { value: "CORNERS", label: "Corners" },
  { value: "CARDS", label: "Cards" },
];

const BTN_BASE = cn("h-7 px-2 text-[11px] gap-1.5 font-normal");

interface MarketsFilterProps {
  /** Selected market values. Empty array means "All" (no filter). */
  selected: string[];
  onChange: (values: string[]) => void;
  align?: "start" | "end" | "center";
}

export function MarketsFilter({
  selected,
  onChange,
  align = "start",
}: MarketsFilterProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={BTN_BASE}>
          Markets
          <TriggerBadge active={selected.length > 0}>
            {selected.length === 0 ? "All" : selected.length}
          </TriggerBadge>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[220px]">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            Markets
          </DropdownMenuLabel>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {MARKET_OPTIONS.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={selected.includes(opt.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(checked) => {
              const next = checked
                ? [...selected, opt.value]
                : selected.filter((v) => v !== opt.value);
              onChange(next);
            }}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
