"use client";

import { RefreshCw } from "lucide-react";
import { LoadingButton } from "@/components/ui/loading-button";
import { cn } from "@/lib/utils";

export interface RefreshButtonProps {
  onRefresh: () => void;
  isRefreshing?: boolean;
  label?: string;
  disabled?: boolean;
  className?: string;
}

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
