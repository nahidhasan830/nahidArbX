"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";
import type {
  MemoryDiagnostic as MemoryDiagnosticData,
  MemoryDiagnosticStore,
} from "@/app/api/logs/memory/route";

const STORE_LABELS: Record<string, string> = {
  oddsHistory: "Odds History",
  atomsOdds: "Atoms Odds",
  scores: "Scores",
  multiSourceScores: "Multi-Source Scores",
  marketLimits: "Market Limits",
  matchCache: "Match Cache",
  aiDecisionCache: "AI Decision Cache",
  sessionDiagnostics: "Session Diagnostics",
  valueBets: "Value Bets",
  events: "Events",
  deltaSnapshot: "Delta Snapshot",
};

function formatStoreDetails(
  key: string,
  store: MemoryDiagnosticStore,
): string {
  switch (key) {
    case "oddsHistory":
      return `${store.trackedAtoms?.toLocaleString() ?? 0} atoms, ${store.totalTicks?.toLocaleString() ?? 0} ticks`;
    case "atomsOdds":
      return `${store.events ?? 0} events → ${store.families ?? 0} families → ${store.atoms ?? 0} atoms → ${store.oddsRecords?.toLocaleString() ?? 0} records`;
    case "scores":
      return `${store.live ?? 0} live + ${store.corners ?? 0} corners`;
    case "multiSourceScores":
      return `${store.entries?.toLocaleString() ?? 0} entries`;
    case "marketLimits":
      return `${store.entries?.toLocaleString() ?? 0} entries`;
    case "matchCache":
      return `${store.cachedEvents ?? 0} events cached`;
    case "aiDecisionCache":
      return `${store.total?.toLocaleString() ?? 0} decisions`;
    case "sessionDiagnostics":
      return `${store.providers ?? 0} providers, ${store.totalSteps?.toLocaleString() ?? 0} steps`;
    case "valueBets":
      return `${store.count?.toLocaleString() ?? 0} active`;
    case "events":
      return `${store.count?.toLocaleString() ?? 0} normalized`;
    case "deltaSnapshot":
      return store.hasSnapshot ? `${store.snapshotValueBets ?? 0} bets duplicated` : "No snapshot";
    default:
      return "-";
  }
}

function getRiskBadge(issue?: string): { variant: "success" | "warning" | "destructive"; label: string } {
  if (!issue) return { variant: "success", label: "OK" };
  if (issue.includes("NO CLEANUP") || issue.includes("UNBOUNDED")) {
    return { variant: "destructive", label: "HIGH RISK" };
  }
  if (issue.includes("NO EVICTION") || issue.includes("grows forever")) {
    return { variant: "warning", label: "MEDIUM RISK" };
  }
  return { variant: "success", label: "OK" };
}

function formatMB(mb: number | undefined): string {
  if (mb === undefined) return "-";
  return `${mb.toFixed(2)} MB`;
}

function MemoryStatCard({
  label,
  value,
  total,
  unit = "MB",
}: {
  label: string;
  value: number;
  total?: number;
  unit?: string;
}) {
  const percentage = total ? (value / total) * 100 : 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-2xl font-bold font-mono">
          {value.toFixed(0)}
          <span className="text-sm font-normal text-muted-foreground ml-1">
            {unit}
          </span>
        </div>
        {total && (
          <>
            <Progress value={percentage} className="h-2" />
            <div className="text-[10px] text-muted-foreground font-mono">
              {value.toFixed(0)} / {total.toFixed(0)} {unit}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function MemoryDiagnostic() {
  const {
    data,
    isLoading,
    isError,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useQuery<MemoryDiagnosticData>({
    queryKey: ["memory-diagnostic"],
    queryFn: async () => {
      const res = await fetch("/api/logs/memory");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 10_000,
    staleTime: 10_000,
  });

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : "Never";

  // Calculate totals
  const totalEstimatedMB = data
    ? Object.values(data.stores).reduce(
        (sum, store) => sum + (store.estimatedMB ?? 0),
        0
      )
    : 0;

  const unaccountedMB = data
    ? data.process.heapUsedMB - totalEstimatedMB
    : 0;

  const highRiskStores = data
    ? Object.entries(data.stores).filter(([, store]) => {
        const risk = getRiskBadge(store.issue);
        return risk.variant === "destructive" || risk.variant === "warning";
      }).length
    : 0;

  // Sort stores by estimated MB descending
  const sortedStores = data
    ? Object.entries(data.stores).sort(
        (a, b) => (b[1].estimatedMB ?? 0) - (a[1].estimatedMB ?? 0)
      )
    : [];

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-3 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24 mb-2" />
                <Skeleton className="h-2 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-96">
          <div className="text-center space-y-2">
            <AlertTriangle className="h-12 w-12 mx-auto text-destructive" />
            <p className="text-lg font-semibold">Engine Unreachable</p>
            <p className="text-sm text-muted-foreground">
              Make sure the engine is running on port 3001
            </p>
            <Button onClick={() => refetch()} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {highRiskStores > 0 ? (
              <Badge variant="destructive" className="gap-1.5">
                <AlertTriangle className="h-3 w-3" />
                {highRiskStores} High Risk {highRiskStores === 1 ? "Store" : "Stores"}
              </Badge>
            ) : (
              <Badge variant="success" className="gap-1.5">
                <CheckCircle2 className="h-3 w-3" />
                All Stores OK
              </Badge>
            )}
            <div className="text-xs text-muted-foreground">
              Last updated: {lastUpdated}
            </div>
          </div>
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Process Memory Cards */}
        <div className="grid grid-cols-4 gap-4">
          <MemoryStatCard
            label="Heap Used"
            value={data.process.heapUsedMB}
            total={data.process.heapTotalMB}
          />
          <MemoryStatCard
            label="Heap Total"
            value={data.process.heapTotalMB}
          />
          <MemoryStatCard label="RSS" value={data.process.rssMB} />
          <MemoryStatCard label="External" value={data.process.externalMB} />
        </div>

        {/* Summary Stats */}
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center justify-around">
              <div className="text-center">
                <div className="text-2xl font-bold font-mono">
                  {totalEstimatedMB.toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  Total Stores
                </div>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="text-center">
                <div className="text-2xl font-bold font-mono">
                  {unaccountedMB.toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  Unaccounted
                </div>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="text-center">
                <div className="text-2xl font-bold font-mono">
                  {Object.keys(data.stores).length}
                </div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  Stores Tracked
                </div>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="text-center">
                <div className="text-2xl font-bold font-mono">
                  {highRiskStores}
                </div>
                <div className="text-xs text-muted-foreground uppercase tracking-wide">
                  High Risk
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Store Breakdown Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">
              Store Breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">Store</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead className="text-right w-[120px]">Est. MB</TableHead>
                  <TableHead className="text-right w-[120px]">Risk</TableHead>
                  <TableHead className="w-[200px]">Issues</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedStores.map(([key, store]) => {
                  const risk = getRiskBadge(store.issue);
                  return (
                    <TableRow key={key}>
                      <TableCell className="font-medium font-mono text-xs">
                        <Tooltip>
                          <TooltipTrigger>
                            {STORE_LABELS[key] || key}
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs">Store key: {key}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatStoreDetails(key, store)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMB(store.estimatedMB)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={risk.variant} className="text-[10px]">
                          {risk.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {store.issue ? (
                          <div className="flex items-center gap-1.5 text-destructive">
                            <AlertTriangle className="h-3 w-3 shrink-0" />
                            <span className="truncate">{store.issue}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Footer info */}
        <div className="text-center text-xs text-muted-foreground pb-4">
          Data refreshes automatically every 10 seconds
        </div>
      </div>
    </TooltipProvider>
  );
}
