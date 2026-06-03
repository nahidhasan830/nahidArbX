"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export function ProviderHealthBanner() {
  const { alerts, dismissAlert } = useProviderHealthAlerts();

  if (alerts.length === 0) return null;

  const downCount = alerts.filter((alert) => alert.severity === "down").length;
  const Icon = downCount > 0 ? AlertTriangle : CheckCircle2;

  return (
    <div className="border-b border-border bg-background/95 px-3 py-2 backdrop-blur-xl">
      <div className="flex flex-col gap-2 text-xs text-foreground/85 lg:flex-row lg:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-md border",
              downCount > 0
                ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-foreground">
              Provider health alert
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {downCount > 0
                ? `${downCount} provider${downCount === 1 ? "" : "s"} down`
                : "Provider data is degraded"}
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {alerts.map((alert) => (
            <div
              key={alert.fingerprint}
              className={cn(
                "flex min-w-0 max-w-full items-center gap-2 rounded-md border px-2 py-1",
                severityClasses(alert.severity),
              )}
            >
              <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tabular-nums">
                {alert.severity}
              </span>
              <span className="truncate font-semibold">{alert.displayName}</span>
              <span className="hidden min-w-0 truncate text-muted-foreground sm:inline">
                {alert.reason}
              </span>
              <span className="hidden shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground md:inline">
                last {formatLastSuccess(alert.lastSuccessAt)}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="ml-0.5 size-5 rounded-sm text-current hover:bg-foreground/10"
                    onClick={() => dismissAlert(alert.fingerprint)}
                  >
                    <X className="size-3" />
                    <span className="sr-only">
                      Dismiss {alert.displayName} alert
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Dismiss until this alert changes
                </TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {alerts[0].action}
      </div>
    </div>
  );
}
