"use client";

import * as React from "react";
import { AlertTriangle, CircleAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProviderHealthAlerts } from "@/components/hooks/useProviderHealthAlerts";
import { cn } from "@/lib/utils";
import type { ProviderAlert } from "@/lib/providers/health-alerts";

function formatLastSuccess(value: string | null): string {
  if (!value) return "never";
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const deltaMs = Date.now() - ms;
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 60 * 60_000) {
    return `${Math.max(1, Math.round(deltaMs / 60_000))}m ago`;
  }
  return `${Math.round(deltaMs / (60 * 60_000))}h ago`;
}

function severityClasses(severity: ProviderAlert["severity"]): string {
  return severity === "down"
    ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function severityLabel(alerts: ProviderAlert[]): string {
  const downCount = alerts.filter((alert) => alert.severity === "down").length;
  if (downCount > 0) return `${downCount} down`;
  return `${alerts.length} degraded`;
}

export function ProviderHealthBadge() {
  const { allAlerts } = useProviderHealthAlerts();
  const [open, setOpen] = React.useState(false);
  const alerts = allAlerts;
  const downCount = alerts.filter((alert) => alert.severity === "down").length;
  const hasDown = downCount > 0;
  const Icon = hasDown ? AlertTriangle : CircleAlert;

  React.useEffect(() => {
    if (alerts.length === 0) setOpen(false);
  }, [alerts.length]);

  if (alerts.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-md border px-2 text-xs font-semibold transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                severityClasses(hasDown ? "down" : "degraded"),
              )}
              aria-label="View provider health alerts"
              aria-live="polite"
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{severityLabel(alerts)}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          View provider health alerts
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-1.5rem)] p-3"
      >
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md border",
              severityClasses(hasDown ? "down" : "degraded"),
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              Provider health
            </div>
            <div className="text-xs text-muted-foreground">
              {hasDown
                ? `${downCount} provider${downCount === 1 ? "" : "s"} down`
                : "Provider data is degraded"}
            </div>
          </div>
        </div>

        <div className="mt-3 max-h-[300px] space-y-2 overflow-y-auto pr-1">
          {alerts.map((alert) => (
            <div
              key={alert.fingerprint}
              className={cn(
                "rounded-md border px-2.5 py-2",
                severityClasses(alert.severity),
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tabular-nums">
                  {alert.severity}
                </span>
                <span className="min-w-0 truncate text-xs font-semibold">
                  {alert.displayName}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {formatLastSuccess(alert.lastSuccessAt)}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {alert.reason}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {alert.action}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
