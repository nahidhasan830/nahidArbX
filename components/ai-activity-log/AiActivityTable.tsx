"use client";

/**
 * AiActivityTable — DataTable displaying every AI operation.
 */

import { useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DataTable } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { fmtSeen } from "@/lib/formatting/helpers";
import type { AiActivityLogRow } from "@/lib/db/schema";

const PERSISTENCE_KEY = "ai-activity-log-table:layout:v1";

const STATUS_PILL: Record<string, string> = {
  success: "bg-emerald-500/8 text-emerald-400/90 border border-emerald-500/20",
  partial: "bg-amber-500/8 text-amber-400/80 border border-amber-500/20",
  error: "bg-red-500/8 text-red-400/80 border border-red-500/20",
};
const STATUS_LABEL: Record<string, string> = {
  success: "Success", partial: "Partial", error: "Error",
};

const SYSTEM_COLORS: Record<string, string> = {
  settlement: "text-blue-400", grounding: "text-purple-400",
  "entity-match": "text-cyan-400", analysis: "text-amber-400", propose: "text-emerald-400",
};
const SYSTEM_LABELS: Record<string, string> = {
  settlement: "Settlement", grounding: "Grounding",
  "entity-match": "Entity Match", analysis: "Analysis", propose: "Propose",
};
const SYSTEM_TOOLTIPS: Record<string, string> = {
  settlement: "Gemini-powered bet settlement (Tier 3)",
  grounding: "Search-grounded AI queries via Groq",
  "entity-match": "AI-assisted entity matching for event pairs",
  analysis: "AI analysis of betting patterns and performance",
  propose: "AI strategy rule proposals from historical data",
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual", "auto-scheduler": "Auto", playground: "Playground", batch: "Batch",
};
const TRIGGER_COLORS: Record<string, string> = {
  manual: "text-zinc-400", "auto-scheduler": "text-blue-400",
  playground: "text-purple-400", batch: "text-amber-400",
};

export type AiActivityTableProps = {
  rows: AiActivityLogRow[];
  loading?: boolean;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  renderFooter?: () => React.ReactNode;
};

export function AiActivityLogTable({
  rows, loading, hasNextPage, isFetchingNextPage, onLoadMore, renderFooter,
}: AiActivityTableProps) {
  const columns = useMemo<ColumnDef<AiActivityLogRow, unknown>[]>(() => [
    {
      id: "time", accessorKey: "createdAt", header: "Time",
      cell: ({ row }) => {
        const t = row.original.createdAt;
        return (<Tooltip><TooltipTrigger asChild><span className="text-[10px] text-muted-foreground cursor-help">{fmtSeen(t)}</span></TooltipTrigger><TooltipContent side="top">{new Date(t).toLocaleString()}</TooltipContent></Tooltip>);
      },
      meta: { hint: "When the AI operation occurred.", align: "center" as const, initialSize: 55 },
    },
    {
      id: "status", accessorKey: "status", header: "Status",
      cell: ({ row }) => {
        const s = row.original.status;
        return (<span className={cn("inline-flex items-center justify-center h-5 rounded-md px-2 text-[10px] font-medium", STATUS_PILL[s] ?? STATUS_PILL.error)}>{STATUS_LABEL[s] ?? s}</span>);
      },
      meta: { hint: "Outcome: success, partial, or error.", align: "center" as const, initialSize: 80 },
    },
    {
      id: "system", accessorKey: "system", header: "System",
      cell: ({ row }) => {
        const sys = row.original.system;
        return (<Tooltip><TooltipTrigger asChild><span className={cn("text-[10px] font-medium cursor-help", SYSTEM_COLORS[sys] ?? "text-muted-foreground")}>{SYSTEM_LABELS[sys] ?? sys}</span></TooltipTrigger><TooltipContent side="top" className="max-w-xs">{SYSTEM_TOOLTIPS[sys] ?? "AI operation"}</TooltipContent></Tooltip>);
      },
      meta: { hint: "Which AI subsystem handled this.", align: "center" as const, initialSize: 100 },
    },
    {
      id: "trigger", accessorKey: "trigger", header: "Trigger",
      cell: ({ row }) => {
        const t = row.original.trigger;
        return (<span className={cn("inline-flex items-center rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium", TRIGGER_COLORS[t] ?? "text-muted-foreground")}>{TRIGGER_LABELS[t] ?? t}</span>);
      },
      meta: { hint: "How the operation was triggered.", initialSize: 85 },
    },
    {
      id: "model", accessorKey: "model", header: "Model",
      cell: ({ row }) => {
        const m = row.original.model;
        if (!m) return <span className="text-muted-foreground/40">&mdash;</span>;
        return <span className="text-[11px]">{m}</span>;
      },
      meta: { hint: "AI model used.", align: "center" as const, initialSize: 110 },
    },
    {
      id: "items", accessorKey: "itemCount", header: "Items",
      cell: ({ row }) => {
        const n = row.original.itemCount;
        if (n == null) return <span className="text-muted-foreground/40">&mdash;</span>;
        return <span className="tabular-nums font-medium">{n}</span>;
      },
      meta: { hint: "Number of items processed.", align: "right" as const, initialSize: 60 },
    },
    {
      id: "duration", accessorKey: "durationMs", header: "Duration",
      cell: ({ row }) => {
        const ms = row.original.durationMs;
        if (ms == null) return <span className="text-muted-foreground/40">&mdash;</span>;
        const fmt = ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
        return (<span className={cn("tabular-nums text-[11px]", ms > 10000 && "text-amber-400", ms > 30000 && "text-red-400")}>{fmt}</span>);
      },
      meta: { hint: "Operation duration.", align: "right" as const, initialSize: 75 },
    },
    {
      id: "cost", accessorKey: "costUsd", header: "Cost",
      cell: ({ row }) => {
        const c = row.original.costUsd;
        if (c == null || c === 0) return <span className="text-muted-foreground/40">&mdash;</span>;
        return (<span className={cn("tabular-nums text-[11px] font-medium", c > 0.5 && "text-amber-400", c > 1.0 && "text-red-400")}>${c.toFixed(4)}</span>);
      },
      meta: { hint: "Estimated cost in USD.", align: "right" as const, initialSize: 70 },
    },
    {
      id: "summary", header: "Summary", accessorKey: "summary",
      cell: ({ row }) => {
        const s = row.original.summary;
        if (!s) return <span className="text-muted-foreground/40">&mdash;</span>;
        return (<Tooltip><TooltipTrigger asChild><span className="text-[10px] text-muted-foreground truncate max-w-[250px] inline-block cursor-help">{s}</span></TooltipTrigger><TooltipContent side="top" className="max-w-md whitespace-pre-wrap text-xs">{s}</TooltipContent></Tooltip>);
      },
      meta: { hint: "Human-readable summary.", initialSize: 250 },
    },
    {
      id: "error", header: "Error", accessorKey: "error",
      cell: ({ row }) => {
        const e = row.original.error;
        if (!e) return <span className="text-muted-foreground/40">&mdash;</span>;
        return (<Tooltip><TooltipTrigger asChild><span className="text-[10px] text-red-400 truncate max-w-[200px] inline-block cursor-help">{e}</span></TooltipTrigger><TooltipContent side="top" className="max-w-md whitespace-pre-wrap text-xs">{e}</TooltipContent></Tooltip>);
      },
      meta: { hint: "Detailed error message.", initialSize: 200 },
    },
  ], []);

  return (
    <DataTable<AiActivityLogRow>
      data={rows}
      columns={columns}
      getRowId={(row) => String(row.id)}
      enableSorting
      enableColumnResizing
      enableColumnOrdering
      enableVirtualization
      rowHeight={30}
      persistenceKey={PERSISTENCE_KEY}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={onLoadMore}
      loading={loading}
      renderFooter={renderFooter}

      renderEmpty={() => (
        <div className="flex flex-col items-center gap-1.5 py-12 text-muted-foreground">
          <span className="text-sm font-medium">No AI activity</span>
          <span className="text-xs opacity-70">No AI operations logged yet, or adjust your filters.</span>
        </div>
      )}
    />
  );
}
