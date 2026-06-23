
"use client";

import { useMemo, useState, useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketScopeBadge } from "@/components/ui/market-display";
import { TriggerBadge } from "./TriggerBadge";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getMarketOptions,
  formatMarketType,
  type MarketOption,
} from "@/lib/formatting/labels";
import atomsData from "@/lib/atoms/atoms.json";

export const MARKET_OPTIONS: MarketOption[] = getMarketOptions();

const KNOWN_VALUES = new Set(MARKET_OPTIONS.map((o) => o.value));
const BTN_BASE = cn("h-7 px-2 text-[11px] gap-1.5 font-normal");


interface MarketGroup {
  label: string;
  types: string[];
}

const MARKET_GROUPS: MarketGroup[] = [
  {
    label: "Goals",
    types: [
      "MATCH_RESULT",
      "TOTAL_GOALS",
      "BTTS",
      "HOME_TEAM_TOTAL",
      "AWAY_TEAM_TOTAL",
      "ODD_EVEN_GOALS",
    ],
  },
  {
    label: "Handicaps",
    types: ["ASIAN_HANDICAP", "EUROPEAN_HANDICAP", "DOUBLE_CHANCE", "DNB"],
  },
  {
    label: "Specials",
    types: ["CLEAN_SHEET", "WIN_TO_NIL", "TO_SCORE"],
  },
  {
    label: "Corners",
    types: [
      "CORNERS",
      "CORNERS_HANDICAP",
      "CORNERS_EUROPEAN_HANDICAP",
      "HOME_CORNERS_TOTAL",
      "AWAY_CORNERS_TOTAL",
    ],
  },
  {
    label: "Cards & Bookings",
    types: ["CARDS", "BOOKINGS", "BOOKINGS_HANDICAP"],
  },
];

type TimeScopeLabel = "FT" | "1H" | "2H";

const TIME_SCOPE_ORDER: TimeScopeLabel[] = ["FT", "1H", "2H"];

const _timeScopesByMarketType: Record<string, Set<string>> = (() => {
  const result: Record<string, Set<string>> = {};
  const families = atomsData.families as Record<
    string,
    { market_type: string; time_scope: string }
  >;
  for (const fam of Object.values(families)) {
    if (!result[fam.market_type]) result[fam.market_type] = new Set();
    result[fam.market_type].add(fam.time_scope);
  }
  return result;
})();

function getTimeScopeBadges(marketType: string): TimeScopeLabel[] {
  const scopes = _timeScopesByMarketType[marketType];
  if (!scopes) return [];
  return TIME_SCOPE_ORDER.filter((ts) => scopes.has(ts));
}

const _groupedTypes = new Set(MARKET_GROUPS.flatMap((g) => g.types));

function getGroupedOptions(allOptions: MarketOption[]): {
  groups: { label: string; options: MarketOption[] }[];
  ungrouped: MarketOption[];
} {
  const optionMap = new Map(allOptions.map((o) => [o.value, o]));
  const groups: { label: string; options: MarketOption[] }[] = [];

  for (const group of MARKET_GROUPS) {
    const options = group.types
      .filter((t) => optionMap.has(t))
      .map((t) => optionMap.get(t)!);
    if (options.length > 0) {
      groups.push({ label: group.label, options });
    }
  }

  const ungrouped = allOptions.filter((o) => !_groupedTypes.has(o.value));
  return { groups, ungrouped };
}


interface MarketsFilterProps {
  selected: string[];
  onChange: (values: string[]) => void;
  align?: "start" | "end" | "center";
}

export function MarketsFilter({
  selected,
  onChange,
  align = "start",
}: MarketsFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const displayOptions = useMemo(() => {
    const unknown = selected.filter((v) => !KNOWN_VALUES.has(v));
    if (unknown.length === 0) return MARKET_OPTIONS;
    return [
      ...MARKET_OPTIONS,
      ...unknown.map((v) => ({ value: v, label: formatMarketType(v) })),
    ];
  }, [selected]);

  const { groups, ungrouped } = useMemo(
    () => getGroupedOptions(displayOptions),
    [displayOptions],
  );

  const searchLower = search.toLowerCase().trim();

  const filteredGroups = useMemo(() => {
    if (!searchLower) return groups;
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) =>
          o.label.toLowerCase().includes(searchLower),
        ),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, searchLower]);

  const filteredUngrouped = useMemo(() => {
    if (!searchLower) return ungrouped;
    return ungrouped.filter((o) => o.label.toLowerCase().includes(searchLower));
  }, [ungrouped, searchLower]);

  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    onChange(next);
  };

  const toggleGroup = (groupTypes: string[]) => {
    const available = groupTypes.filter((t) =>
      displayOptions.some((o) => o.value === t),
    );
    const allSelected = available.every((t) => selected.includes(t));
    if (allSelected) {
      onChange(selected.filter((v) => !available.includes(v)));
    } else {
      const merged = new Set([...selected, ...available]);
      onChange(Array.from(merged));
    }
  };

  const totalVisible =
    filteredGroups.reduce((s, g) => s + g.options.length, 0) +
    filteredUngrouped.length;

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={BTN_BASE}>
          Markets
          <TriggerBadge active={selected.length > 0}>
            {selected.length === 0 ? "All" : selected.length}
          </TriggerBadge>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[280px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-center border-b px-3 py-2">
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search markets..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[10px] text-muted-foreground hover:text-foreground shrink-0 ml-2"
            >
              Clear
            </button>
          )}
        </div>

        <div className="max-h-[360px] overflow-y-auto py-1">
          {totalVisible === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              No markets match &ldquo;{search}&rdquo;
            </p>
          )}

          {filteredGroups.map((group) => (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => toggleGroup(group.options.map((o) => o.value))}
                className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                <span className="font-medium">{group.label}</span>
                <span className="text-[9px] tabular-nums opacity-70">
                  {
                    group.options.filter((o) => selected.includes(o.value))
                      .length
                  }
                  /{group.options.length}
                </span>
              </button>

              {group.options.map((opt) => (
                <MarketCheckboxItem
                  key={opt.value}
                  label={opt.label}
                  checked={selected.includes(opt.value)}
                  badges={getTimeScopeBadges(opt.value)}
                  onToggle={() => toggle(opt.value)}
                />
              ))}
            </div>
          ))}

          {filteredUngrouped.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                Other
              </div>
              {filteredUngrouped.map((opt) => (
                <MarketCheckboxItem
                  key={opt.value}
                  label={opt.label}
                  checked={selected.includes(opt.value)}
                  badges={getTimeScopeBadges(opt.value)}
                  onToggle={() => toggle(opt.value)}
                />
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}


function MarketCheckboxItem({
  label,
  checked,
  badges,
  onToggle,
}: {
  label: string;
  checked: boolean;
  badges: TimeScopeLabel[];
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer",
        "hover:bg-accent/50 transition-colors",
        checked && "text-foreground",
        !checked && "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center size-3.5 rounded-[3px] border shrink-0",
          checked
            ? "bg-primary border-primary text-primary-foreground"
            : "border-muted-foreground/30",
        )}
      >
        {checked && <Check className="size-2.5" strokeWidth={3} />}
      </span>

      <span className="flex-1 text-left truncate">{label}</span>

      {badges.length > 0 && (
        <span className="flex items-center gap-0.5 shrink-0">
          {badges.map((b) => (
            <MarketScopeBadge key={b} scope={b} withTooltip={false} />
          ))}
        </span>
      )}
    </button>
  );
}
