"use client";

import { useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronRight, AlertTriangle, Zap, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnomalyRow } from "../types";

function AnomalyDetailCard({ row }: { row: AnomalyRow }) {
  const isReversal = row.anomalyType === "participant_reversal";
  const softIpPct =
    row.ipSoft != null ? (row.ipSoft * 100).toFixed(1) : "—";
  const sharpIpPct =
    row.ipSharp != null ? (row.ipSharp * 100).toFixed(1) : "—";
  const softBarWidth =
    row.ipSoft != null ? Math.min(row.ipSoft * 100, 100) : 0;
  const sharpBarWidth =
    row.ipSharp != null ? Math.min(row.ipSharp * 100, 100) : 0;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold flex items-center gap-2">
           <AlertTriangle
              className={cn(
                "size-4",
                isReversal ? "text-red-400" : "text-amber-400",
              )}
            />
            Odds Comparison —{" "}
            <span className="font-mono text-muted-foreground text-xs">
              {row.atomId}
            </span>
        </h4>
        <Button variant="outline" size="sm" className="h-7 text-[11px]" asChild>
          <a href={`/diagnostics?tab=entities&search=${row.eventId}`} target="_blank" rel="noopener noreferrer">
             Inspect Entities <ExternalLink className="size-3 ml-1.5" />
          </a>
        </Button>
      </div>

      <div className="space-y-2 bg-muted/20 p-4 rounded-md border border-border">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-24 text-right font-medium text-muted-foreground uppercase tracking-wide shrink-0">
            {row.softProvider}
          </span>
          <div className="flex-1 h-6 bg-muted/40 rounded-sm overflow-hidden relative border border-border/50">
            <div
              className="h-full bg-amber-500/40 rounded-sm transition-all"
              style={{ width: `${softBarWidth}%` }}
            />
            <span className="absolute inset-y-0 left-2 flex items-center text-[11px] tabular-nums font-medium">
              {row.softOdds?.toFixed(2) ?? "—"} (IP: {softIpPct}%)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-24 text-right font-medium text-blue-400 uppercase tracking-wide shrink-0">
            {row.sharpProvider}{" "}
            <Zap className="inline size-2.5 ml-1" />
          </span>
          <div className="flex-1 h-6 bg-muted/40 rounded-sm overflow-hidden relative border border-border/50">
            <div
              className="h-full bg-blue-500/30 rounded-sm transition-all"
              style={{ width: `${sharpBarWidth}%` }}
            />
            <span className="absolute inset-y-0 left-2 flex items-center text-[11px] tabular-nums font-medium">
              {row.sharpOdds?.toFixed(2) ?? "—"} (IP: {sharpIpPct}%)
            </span>
          </div>
        </div>
      </div>

      <div
        className={cn(
          "rounded-md px-3 py-2 text-sm",
          isReversal
            ? "bg-red-500/10 border border-red-500/20"
            : "bg-amber-500/10 border border-amber-500/20",
        )}
      >
        <div className="flex items-start gap-2">
          <AlertTriangle
            className={cn(
              "size-4 shrink-0 mt-0.5",
              isReversal ? "text-red-400" : "text-amber-400",
            )}
          />
          <div>
            <p className="font-medium">
              {isReversal
                ? "Likely participant reversal"
                : "Significant odds deviation"}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
              {isReversal
                ? `${row.softProvider} and ${row.sharpProvider} disagree by ${row.deviationPct?.toFixed(1)}% — the home/away teams are probably swapped in the provider's feed. This creates massive fake EV. Use the Entity Inspector to fix the alias.`
                : `${row.deviationPct?.toFixed(1)}% IP gap between ${row.softProvider} and ${row.sharpProvider}. Could be a mapping math error, line syntax mismatch, or time context bleed (HT vs FT).`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AnomalyXRayTab({
  data,
  loading,
}: {
  data: AnomalyRow[];
  loading: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const columns: ColumnDef<AnomalyRow, unknown>[] = useMemo(
    () => [
      {
        id: "expand",
        header: "",
        cell: ({ row }) => {
          const isExpanded = expandedId === row.original.id;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() =>
                    setExpandedId(isExpanded ? null : row.original.id)
                  }
                  className="p-0.5 rounded hover:bg-muted/60 transition-colors"
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>Expand to see odds comparison</TooltipContent>
            </Tooltip>
          );
        },
        size: 36,
      },
      {
        accessorKey: "anomalyType",
        header: "Type",
        cell: ({ row }) => {
          const isReversal = row.original.anomalyType === "participant_reversal";
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant={isReversal ? "destructive" : "secondary"}
                  className={cn(
                    "text-[10px] whitespace-nowrap",
                    !isReversal &&
                      "bg-orange-500/15 text-orange-400 border-orange-500/30",
                  )}
                >
                  {isReversal ? "Reversal" : "Deviation"}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {isReversal
                  ? "IP deviation > 30% — likely home/away teams are swapped between providers"
                  : "IP deviation 15–30% — significant odds mismatch, possibly a mapping error"}
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 110,
      },
      {
        accessorKey: "softProvider",
        header: "Soft Provider",
        cell: ({ row }) => (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.original.softProvider}
          </span>
        ),
        size: 130,
      },
      {
        accessorKey: "atomId",
        header: "Atom ID",
        cell: ({ row }) => (
          <span className="text-sm font-mono truncate block max-w-[260px]">
            {row.original.atomId}
          </span>
        ),
        size: 260,
      },
      {
        id: "odds",
        header: "Odds (Soft → Sharp)",
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="text-sm tabular-nums font-medium">
              <span className="text-amber-400">
                {r.softOdds?.toFixed(2) ?? "?"}
              </span>
              <span className="text-muted-foreground mx-2">→</span>
              <span className="text-blue-400">
                {r.sharpOdds?.toFixed(2) ?? "?"}
              </span>
            </span>
          );
        },
        size: 180,
      },
      {
        accessorKey: "deviationPct",
        header: "Deviation",
        cell: ({ row }) => {
          const r = row.original;
          const dev = r.deviationPct ?? 0;
          const isReversal = dev > 30;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-sm font-semibold tabular-nums",
                    isReversal ? "text-red-400" : "text-amber-400",
                  )}
                >
                  {dev.toFixed(1)}%
                  {isReversal && (
                    <AlertTriangle className="inline size-3 ml-1" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                 Absolute difference between soft and sharp implied probabilities.
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 90,
      },
      {
        accessorKey: "timestamp",
        header: "Flagged At",
        cell: ({ row }) => {
          const d = new Date(row.original.timestamp);
          return (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {d.toLocaleDateString()}{" "}
              {d.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          );
        },
        size: 140,
      },
    ],
    [expandedId],
  );

  const expandedRow = expandedId
    ? data.find((r) => r.id === expandedId)
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <DataTable
        data={data}
        columns={columns}
        getRowId={(row) => row.id}
        enableSorting
        loading={loading}
        renderEmpty={() =>
          "No anomalies detected. The value pipeline runs continuous IP-deviation checks."
        }
        rowClassName={(row) =>
          row.id === expandedId ? "bg-muted/30" : undefined
        }
      />

      {expandedRow && (
        <div className="border-t border-border p-4 bg-background shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold">Anomaly Details</h4>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setExpandedId(null)}
            >
              Close
            </Button>
          </div>
          <AnomalyDetailCard row={expandedRow} />
        </div>
      )}
    </div>
  );
}
