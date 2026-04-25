/**
 * ProvidersFilter — shared soft-provider filter dropdown.
 *
 * Used in both BetsHistoryToolbar and SpreadsheetToolbar so that
 * strategy-configured soft providers filter consistently across both views.
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

// ── Soft provider options (keep in sync with strategy config) ─────────────────
export const SOFT_PROVIDER_OPTIONS: {
  value: string;
  label: string;
  short: string;
}[] = [
  { value: "ninewickets-exchange", label: "9W Exchange", short: "NWEx" },
  { value: "ninewickets-sportsbook", label: "9W Sportsbook", short: "NWSB" },
  { value: "betconstruct", label: "BetConstruct", short: "BC" },
];

const BTN_BASE = cn("h-7 px-2 text-[11px] gap-1.5 font-normal");

interface ProvidersFilterProps {
  /** Selected provider values. Empty array means "All" (no filter). */
  selected: string[];
  onChange: (values: string[]) => void;
  align?: "start" | "end" | "center";
}

export function ProvidersFilter({
  selected,
  onChange,
  align = "start",
}: ProvidersFilterProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={BTN_BASE}>
          Providers
          <TriggerBadge active={selected.length > 0}>
            {selected.length === 0 ? "All" : selected.length}
          </TriggerBadge>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-[200px]">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-[10px] uppercase tracking-wider text-muted-foreground">
            Soft providers
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
        {SOFT_PROVIDER_OPTIONS.map((opt) => (
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
            <span className="flex-1">{opt.label}</span>
            <span className="text-[10px] text-muted-foreground">
              {opt.short}
            </span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
