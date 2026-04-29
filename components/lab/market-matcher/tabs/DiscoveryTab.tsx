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
import { ChevronRight, BrainCircuit, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiscoveryCluster } from "../types";
import { ResolutionPanel } from "./ResolutionPanel";

export function DiscoveryTab({
  clusters,
  loading,
}: {
  clusters: DiscoveryCluster[];
  loading: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const columns: ColumnDef<DiscoveryCluster, unknown>[] = useMemo(
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
              <TooltipContent>Expand cluster details</TooltipContent>
            </Tooltip>
          );
        },
        size: 36,
      },
      {
        accessorKey: "clusterName",
        header: "Cluster Topic",
        cell: ({ row }) => (
          <span className="text-sm font-semibold text-primary/90">
            {row.original.clusterName}
          </span>
        ),
        size: 250,
      },
      {
        id: "providers",
        header: "Providers Missing",
        cell: ({ row }) => {
          const names = row.original.markets.map((m) => m.provider);
          // Show up to 3 names, then "+N"
          const displayNames = names.slice(0, 3);
          const remainder = names.length - 3;
          
          return (
            <div className="flex gap-1.5 flex-wrap items-center">
              {displayNames.map((p) => (
                <Badge
                  key={p}
                  variant="outline"
                  className="text-[10px] uppercase tracking-wide bg-background/50 border-muted-foreground/20"
                >
                  {p}
                </Badge>
              ))}
              {remainder > 0 && (
                <span className="text-[10px] text-muted-foreground ml-1">
                  +{remainder} more
                </span>
              )}
            </div>
          );
        },
        size: 200,
      },
      {
        accessorKey: "totalOccurrences",
        header: "Total Impact",
        cell: ({ row }) => (
          <span className="text-sm font-semibold tabular-nums text-amber-500/90">
            {row.original.totalOccurrences.toLocaleString()}×
          </span>
        ),
        size: 100,
      },
      {
        id: "mlPrediction",
        header: "ML Prediction",
        cell: ({ row }) => {
          // If any market in the cluster has a strong prediction
          const topPrediction = row.original.markets
            .map(m => m.prediction)
            .filter(Boolean)
            .sort((a, b) => (b!.probability - a!.probability))[0];
            
          if (!topPrediction) return <span className="text-muted-foreground text-[11px]">—</span>;
          
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] px-2 py-0.5 rounded font-medium">
                  <BrainCircuit className="size-3" />
                  <span>{topPrediction.targetAtom}</span>
                  <span className="opacity-70">{(topPrediction.probability * 100).toFixed(0)}%</span>
                </div>
              </TooltipTrigger>
              <TooltipContent>LightGBM Prediction</TooltipContent>
            </Tooltip>
          );
        },
        size: 150,
      }
    ],
    [expandedId],
  );

  const expandedRow = expandedId
    ? clusters.find((r) => r.id === expandedId)
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <DataTable
        data={clusters}
        columns={columns}
        getRowId={(row) => row.id}
        enableSorting
        loading={loading}
        renderEmpty={() =>
          "No unmapped market clusters found. Run the sync pipeline to collect data."
        }
        rowClassName={(row) =>
          row.id === expandedId ? "bg-muted/30" : undefined
        }
      />

      {expandedRow && (
        <div className="border-t border-border p-4 bg-background overflow-y-auto shrink-0 max-h-[350px]">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              Cluster Details: <span className="text-primary/70">{expandedRow.clusterName}</span>
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
          
          <div className="grid gap-4 lg:grid-cols-2">
             {expandedRow.markets.map((market) => (
                <ResolutionPanel key={`${market.provider}-${market.marketKey}`} market={market} />
             ))}
          </div>
        </div>
      )}
    </div>
  );
}
