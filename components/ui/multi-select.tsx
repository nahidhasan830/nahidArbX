"use client";

import * as React from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  value: string;
  label: string;
  hint?: string;
};

export type MultiSelectProps = {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Label shown above the option list. */
  title?: string;
  /** Show "All" button to clear selection. */
  showAll?: boolean;
  /** Restrict trigger width. */
  className?: string;
  /** Trigger height in pixels (matches `Input`/`Select` size variants). */
  size?: "sm" | "md";
  /** When all options selected (or none selected) and showAll = true, label like "All providers". */
  allLabel?: string;
  align?: "start" | "center" | "end";
};

/**
 * Generic multi-select dropdown built on top of DropdownMenu.
 * - Empty selection is treated as "all" (no filter).
 * - Use `showAll` + `allLabel` to make that explicit in the trigger.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select…",
  title,
  showAll = true,
  className,
  size = "sm",
  allLabel,
  align = "start",
}: MultiSelectProps) {
  const isAll = selected.length === 0;

  const toggle = (value: string) => {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const clearAll = () => onChange([]);

  const triggerHeight = size === "sm" ? "h-8" : "h-9";

  const triggerLabel = (() => {
    if (isAll) return allLabel ?? placeholder;
    if (selected.length === 1) {
      return options.find((o) => o.value === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} selected`;
  })();

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            triggerHeight,
            "justify-between gap-1.5 px-2.5 text-xs font-normal",
            !isAll && "border-primary/40",
            className,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          {!isAll ? (
            <Badge
              variant="secondary"
              className="h-4 px-1 text-[10px] tabular-nums"
            >
              {selected.length}
            </Badge>
          ) : (
            <ChevronDown className="size-3.5 opacity-50" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="min-w-[200px] p-1"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {(title || showAll) && (
          <div className="flex items-center justify-between px-2 pt-1.5 pb-1">
            {title && (
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {title}
              </span>
            )}
            {showAll && !isAll && (
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                Clear
              </button>
            )}
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          {options.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              No options
            </div>
          )}
          {options.map((opt) => {
            const checked = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggle(opt.value)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                  "hover:bg-accent hover:text-accent-foreground",
                  checked && "bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border",
                    checked
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-input bg-transparent",
                  )}
                >
                  {checked && <Check className="size-3" />}
                </span>
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.hint && (
                  <span className="text-[10px] text-muted-foreground">
                    {opt.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
