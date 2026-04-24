"use client";

/**
 * ProviderBadge — colored provider pill that reads display names + colors
 * from the provider registry (lib/providers/registry.ts). One-liner
 * replacement anywhere we previously hand-formatted provider ids.
 *
 *   <ProviderBadge id="ninewickets-sportsbook" />
 *   <ProviderBadge id="pinnacle" size="sm" short />
 *   <ProviderBadge id="betconstruct" withDot />
 */

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
  /** Use the short name ("9W-SB") instead of the display name ("9W Sportsbook"). */
  short?: boolean;
  /** Render a leading colored dot that uses the provider's accent color. */
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
