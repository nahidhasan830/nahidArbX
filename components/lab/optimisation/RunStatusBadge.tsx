"use client";

import { Badge } from "@/components/ui/badge";
import type { OptimizationRunStatus } from "@/lib/optimizer/types";

const STATUS_CONFIG: Record<
  OptimizationRunStatus,
  { label: string; className: string }
> = {
  queued: {
    label: "Queued",
    className: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  },
  running: {
    label: "Running",
    className: "bg-blue-500/15 text-blue-600 border-blue-500/30 animate-pulse",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/15 text-red-600 border-red-500/30",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-muted text-muted-foreground border-border",
  },
};

export function RunStatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status as OptimizationRunStatus] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[10px] px-2 py-0.5 ${config.className}`}
    >
      {config.label}
    </Badge>
  );
}
