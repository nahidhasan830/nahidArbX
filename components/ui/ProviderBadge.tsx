"use client";


import * as React from "react";
import { cn } from "@/lib/utils";
import {
  PROVIDER_REGISTRY,
  getProviderColorClasses,
  getProviderDisplayName,
  getProviderShortName,
  type ProviderKey,
} from "@/lib/providers/registry";

export interface ProviderBadgeProps {
  id: string;
  short?: boolean;
  withDot?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function ProviderBadge({
  id,
  short = false,
  withDot = false,
  size = "md",
  className,
}: ProviderBadgeProps) {
  const label = short ? getProviderShortName(id) : getProviderDisplayName(id);
  const colors = getProviderColorClasses(id);
  const accentBg =
    PROVIDER_REGISTRY[id as ProviderKey]?.color.accent ?? "bg-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-0.5 text-xs",
        colors,
        className,
      )}
    >
      {withDot && <span className={cn("size-1.5 rounded-full", accentBg)} />}
      {label}
    </span>
  );
}
