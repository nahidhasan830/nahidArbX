"use client";

import { RefreshCw } from "lucide-react";
import { LoadingButton } from "@/components/ui/loading-button";
import { cn } from "@/lib/utils";

export interface RefreshButtonProps {
  onRefresh: () => void;
  isRefreshing?: boolean;
  /** Shown as the tooltip / aria-label. Defaults to "Refresh". */
  label?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Compact icon-only refresh button. One pattern everywhere — the spreadsheet
 * toolbars, dashboard header, and account panels all share this hit area so
 * a "refresh" affordance feels the same across the app.
 */
export function RefreshButton({
  onRefresh,
  isRefreshing = false,
  label = "Refresh",
  disabled,
  className,
}: RefreshButtonProps) {
  return (
    <LoadingButton
      variant="ghost"
      size="icon"
      className={cn("size-7", className)}
      onClick={onRefresh}
      loading={isRefreshing}
      disabled={disabled}
      icon={RefreshCw}
      iconClassName="size-3.5"
      aria-label={label}
      title={label}
    />
  );
}
