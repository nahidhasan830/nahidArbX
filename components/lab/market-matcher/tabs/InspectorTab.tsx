"use client";

import { useMemo, useState, useEffect } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronRight, Search, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InspectorRawMarket } from "../types";
import { ResolutionPanel } from "./ResolutionPanel";

export function InspectorTab() {
  const [eventId, setEventId] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [data, setData] = useState<InspectorRawMarket[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchRawData = async () => {
    if (!eventId) return;
    setIsFetching(true);
    try {
      const providers = ["pinnacle", "ninewickets-sportsbook", "ninewickets-exchange", "betconstruct", "velki-sportsbook"];
      const results: InspectorRawMarket[] = [];
      let idCounter = 1;

      for (const provider of providers) {
        try {
          const res = await fetch(`/api/value-bets/raw-data/${eventId}?provider=${provider}`);
          if (res.ok) {
            const data = await res.json();
            if (data.rawResponse) {
              // Extract markets based on provider structure (super basic mock extraction for the UI)
              // In reality, we just dump the rawResponse as an unmapped market block
              // so the user can inspect the whole payload.
              results.push({
                id: String(idCounter++),
                provider,
                marketKey: "RAW_DUMP",
                marketName: "Raw Provider Payload",
                status: "unmapped", // We mark it unmapped so they can open the resolution panel
                samplePayload: data.rawResponse
              });
            }
          }
        } catch (e) {
          console.error(`Failed to fetch ${provider}`, e);
        }
      }
      
      setData(results);
    } catch (err) {
      console.error(err);
    } finally {
      setIsFetching(false);
    }
  };

  const columns: ColumnDef<InspectorRawMarket, unknown>[] = useMemo(
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
                {row.original.status === "unmapped" ? "Open Resolution Panel" : "View mapped payload"}
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 36,
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => (
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {row.original.provider}
          </span>
        ),
        size: 150,
      },
      {
        accessorKey: "marketName",
        header: "Raw Market Name",
        cell: ({ row }) => (
          <span className="text-sm font-semibold">
            {row.original.marketName}
          </span>
        ),
        size: 250,
      },
      {
        accessorKey: "status",
        header: "Mapping Status",
        cell: ({ row }) => {
          const isMapped = row.original.status === "mapped";
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant={isMapped ? "default" : "destructive"}
                  className={cn(
                    "text-[10px] whitespace-nowrap",
                    isMapped && "bg-emerald-500/15 text-emerald-500 border-emerald-500/30 hover:bg-emerald-500/25",
                  )}
                >
                  {isMapped ? "Mapped" : "Unmapped"}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>
                {isMapped ? `Successfully mapped to ${row.original.mappedAtomId}` : "Internal matcher returned null"}
              </TooltipContent>
            </Tooltip>
          );
        },
        size: 120,
      },
      {
        accessorKey: "marketKey",
        header: "Market Key",
        cell: ({ row }) => (
          <span className="text-xs font-mono text-muted-foreground break-all">
            {row.original.marketKey}
          </span>
        ),
      }
    ],
    [expandedId],
  );

  const expandedRow = expandedId
    ? data.find((r) => r.id === expandedId)
    : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="p-4 border-b border-border bg-muted/10 flex items-center gap-3">
        <Activity className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Live Event Inspection</span>
        <Input 
          placeholder="Enter Event ID (e.g. SR:match:1234)" 
          className="max-w-xs h-8 text-sm"
          value={eventId}
          onChange={(e) => setEventId(e.target.value)}
        />
        <Button size="sm" className="h-8" onClick={fetchRawData} disabled={!eventId || isFetching}>
          <Search className="size-3.5 mr-2" />
          Fetch Providers
        </Button>
      </div>

      <DataTable
        data={data}
        columns={columns}
        getRowId={(row) => row.id}
        enableSorting
        loading={isFetching}
        renderEmpty={() =>
          "Enter an Event ID above to run a live diagnostic sweep across all provider APIs."
        }
        rowClassName={(row) =>
          row.id === expandedId ? "bg-muted/30" : undefined
        }
      />

      {expandedRow && (
        <div className="border-t border-border p-4 bg-background shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold flex items-center gap-2">
              Resolution Workbench
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
          
          <div className="max-w-2xl">
            <ResolutionPanel market={expandedRow} />
          </div>
        </div>
      )}
    </div>
  );
}
