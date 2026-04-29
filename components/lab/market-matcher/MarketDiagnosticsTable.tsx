"use client";

/**
 * MarketDiagnosticsTable — unified DataTable for both unmapped markets
 * and market anomalies.
 *
 * Each row is either an unmapped market or an IP-deviation anomaly.
 * Click the expand chevron to see:
 *   - Unmapped → raw JSON payload
 *   - Anomaly  → mini X-Ray odds comparison card
 *
 * Uses <DataTable> component (as required by AGENTS.md).
 */

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
import {
  ChevronRight,
  AlertTriangle,
  HelpCircle,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { UnifiedDiagnosticRow } from "./types";

// ============================================
// Detail panels
// ============================================

function JsonViewer({ data }: { data: unknown }) {
  if (!data)
    return (
      <span className="text-xs text-muted-foreground">
        No payload captured
      </span>
    );
  return (
    <pre className="text-[11px] font-mono leading-relaxed bg-muted/60 rounded-md p-3 overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function AnomalyDetailCard({ row }: { row: UnifiedDiagnosticRow }) {
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
    <div className="space-y-3">
      {/* Visual IP comparison */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-20 text-right font-medium text-muted-foreground uppercase tracking-wide shrink-0">
            {row.softProvider ?? "Soft"}
          </span>
          <div className="flex-1 h-5 bg-muted/40 rounded-sm overflow-hidden relative">
            <div
              className="h-full bg-amber-500/40 rounded-sm transition-all"
              style={{ width: `${softBarWidth}%` }}
            />
            <span className="absolute inset-y-0 left-2 flex items-center text-[10px] tabular-nums font-medium">
              {row.softOdds?.toFixed(2) ?? "—"} (IP: {softIpPct}%)
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="w-20 text-right font-medium text-blue-400 uppercase tracking-wide shrink-0">
            {row.sharpProvider ?? "Sharp"}{" "}
            <Zap className="inline size-2.5" />
          </span>
          <div className="flex-1 h-5 bg-muted/40 rounded-sm overflow-hidden relative">
            <div
              className="h-full bg-blue-500/30 rounded-sm transition-all"
              style={{ width: `${sharpBarWidth}%` }}
            />
            <span className="absolute inset-y-0 left-2 flex items-center text-[10px] tabular-nums font-medium">
              {row.sharpOdds?.toFixed(2) ?? "—"} (IP: {sharpIpPct}%)
            </span>
          </div>
        </div>
      </div>

      {/* Explanation */}
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
            <p className="text-sm text-muted-foreground mt-0.5">
              {isReversal
                ? `${row.softProvider} and ${row.sharpProvider} disagree by ${row.deviationPct?.toFixed(1)}% — the home/away teams are probably swapped in the provider's feed. This creates massive fake EV.`
                : `${row.deviationPct?.toFixed(1)}% IP gap between ${row.softProvider} and ${row.sharpProvider}. Could be a mapping error, line syntax mismatch, or time context bleed (HT vs FT).`}
            </p>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <span>
          Event: <span className="font-mono">{row.eventId}</span>
        </span>
        <span>
          Family: <span className="font-mono">{row.familyId}</span>
        </span>
        <span>
          Atom: <span className="font-mono">{row.atomId}</span>
        </span>
      </div>
    </div>
  );
}

// ============================================
// Component
// ============================================

export function MarketDiagnosticsTable({
  rows,
  loading,
}: {
  rows: UnifiedDiagnosticRow[];
  loading: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const columns: ColumnDef<UnifiedDiagnosticRow, unknown>[] = useMemo(
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
              <TooltipContent>
                {isExpanded
                  ? "Collapse details"
                  : row.original.rowType === "unmapped"
                    ? "Expand to see raw JSON payload"
                    : "Expand to see odds comparison"}
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 36,
        meta: { fixed: "left" as const },
      },
      {
        accessorKey: "rowType",
        header: "Type",
        cell: ({ row }) => {
          const type = row.original.rowType;
          const anomalyType = row.original.anomalyType;
          if (type === "unmapped") {
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="text-[10px] whitespace-nowrap bg-amber-500/15 text-amber-400 border-amber-500/30"
                  >
                    Unmapped
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Provider market that our mapping code can&apos;t resolve to an
                  atom
                </TooltipContent>
              </Tooltip>
            );
          }
          const isReversal = anomalyType === "participant_reversal";
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
        meta: {
          hint: "Unmapped = provider market our code can't map.\nReversal = home/away likely swapped.\nDeviation = odds mismatch > 15%.",
        },
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.original.provider}
          </span>
        ),
        size: 130,
        meta: {
          hint: "The provider that emitted this diagnostic signal.\nFor anomalies, this is the soft bookmaker.",
        },
      },
      {
        accessorKey: "marketKey",
        header: "Market / Atom",
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm font-mono truncate block max-w-[260px]">
                {row.original.marketKey}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              className="max-w-[500px]"
            >
              <p className="text-xs font-mono break-all">
                {row.original.marketKey}
              </p>
              {row.original.marketName && (
                <p className="text-xs text-muted-foreground mt-1">
                  {row.original.marketName}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        ),
        size: 260,
        meta: {
          hint: "Unmapped: raw market key from the provider.\nAnomaly: atom ID where the deviation was detected.",
        },
      },
      {
        accessorKey: "detail",
        header: "Detail",
        cell: ({ row }) => {
          const r = row.original;
          if (r.rowType === "unmapped") {
            return (
              <span className="text-sm text-muted-foreground truncate block max-w-[200px]">
                {r.marketName ?? "—"}
              </span>
            );
          }
          return (
            <span className="text-sm tabular-nums">
              <span className="text-amber-400">
                {r.softOdds?.toFixed(2) ?? "?"}
              </span>
              <span className="text-muted-foreground mx-1">→</span>
              <span className="text-blue-400">
                {r.sharpOdds?.toFixed(2) ?? "?"}
              </span>
            </span>
          );
        },
        size: 180,
        meta: {
          hint: "Unmapped: human-readable market name.\nAnomaly: soft odds → sharp odds comparison.",
        },
      },
      {
        accessorKey: "severity",
        header: "Severity",
        cell: ({ row }) => {
          const r = row.original;
          if (r.rowType === "unmapped") {
            const count = r.occurrenceCount ?? 0;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      count > 100
                        ? "text-red-400"
                        : count > 10
                          ? "text-amber-400"
                          : "text-muted-foreground",
                    )}
                  >
                    {count.toLocaleString()}×
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Times this market was encountered but couldn&apos;t be mapped.
                  Higher = more important to fix.
                </TooltipContent>
              </Tooltip>
            );
          }
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
                    <AlertTriangle className="inline size-3 ml-0.5" />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Absolute difference between soft and sharp implied
                probabilities.
                {isReversal
                  ? " > 30% = likely participant reversal."
                  : " > 15% = significant mismatch."}
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 90,
        meta: {
          align: "right" as const,
          hint: "Unmapped: occurrence count (higher = more urgent).\nAnomaly: IP deviation percentage.",
        },
      },
      {
        accessorKey: "timestamp",
        header: "Last Seen",
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
        meta: {
          hint: "When this diagnostic signal was last observed.",
        },
      },
    ],
    [expandedId],
  );

  // Find expanded row for the detail panel
  const expandedRow = expandedId
    ? rows.find((r) => r.id === expandedId)
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(row) => row.id}
        enableSorting
        loading={loading}
        renderEmpty={() =>
          "No diagnostic signals yet. Unmapped markets and IP-deviation anomalies will appear after the next sync cycle."
        }
        rowClassName={(row) =>
          row.id === expandedId ? "bg-muted/30" : undefined
        }
      />

      {/* Expanded detail panel — renders below the table */}
      {expandedRow && (
        <div className="border-t border-border p-4 space-y-2 bg-background">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              {expandedRow.rowType === "unmapped" ? (
                <>
                  <HelpCircle className="size-4 text-amber-400" />
                  Raw Payload —{" "}
                  <span className="font-mono text-muted-foreground text-xs">
                    {expandedRow.marketKey}
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle
                    className={cn(
                      "size-4",
                      expandedRow.anomalyType === "participant_reversal"
                        ? "text-red-400"
                        : "text-amber-400",
                    )}
                  />
                  Odds Comparison —{" "}
                  <span className="font-mono text-muted-foreground text-xs">
                    {expandedRow.atomId}
                  </span>
                </>
              )}
            </h4>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => setExpandedId(null)}
            >
              Close
            </Button>
          </div>

          {expandedRow.rowType === "unmapped" ? (
            <JsonViewer data={expandedRow.samplePayload} />
          ) : (
            <AnomalyDetailCard row={expandedRow} />
          )}
        </div>
      )}
    </div>
  );
}
