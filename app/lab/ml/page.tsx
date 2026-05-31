"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import {
  MLControlRoom,
  MLHeaderSummary,
  ML_WORKSPACE_TABS,
} from "@/components/lab/ml/MLControlRoom";
import { MLPageSkeleton } from "@/components/lab/ml/MLPageSkeleton";
import type { PipelineData } from "@/components/lab/ml/types";
import { evaluateRungs } from "@/lib/lab/ml/rungs";

function usePipeline() {
  return useQuery<PipelineData>({
    queryKey: ["ml", "pipeline"],
    queryFn: async () => {
      const res = await fetch("/api/ml/pipeline", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: (query) => {
      const state = query.state.data as PipelineData | undefined;
      return state?.training?.modelsInTraining ? 3000 : 15000;
    },
    retry: 1,
  });
}

export default function MLLabPage() {
  const { data, isLoading, isError, refetch, isFetching } = usePipeline();
  const [activeTab, setActiveTab] = useState<string>(
    ML_WORKSPACE_TABS[0].value,
  );

  if (isLoading) {
    return (
      <TooltipProvider delayDuration={150}>
        <AppShell
          title="ML Optimizer"
          edgeToEdge
          tabs={ML_WORKSPACE_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        >
          <MLPageSkeleton />
        </AppShell>
      </TooltipProvider>
    );
  }

  if (isError || !data) {
    return (
      <TooltipProvider delayDuration={150}>
        <AppShell title="ML Optimizer" edgeToEdge>
          <div className="flex flex-1 items-center justify-center bg-background p-4">
            <div className="max-w-md rounded-md border border-rose-500/30 bg-rose-500/10 p-5 text-center backdrop-blur-xl">
              <AlertTriangle className="size-6 text-rose-400 mx-auto mb-2" />
              <h2 className="text-sm font-bold uppercase text-rose-400 mb-1">
                Pipeline data unavailable
              </h2>
              <p className="mb-3 text-sm text-foreground/70">
                ML pipeline data is unavailable. Verify the database and engine
                are healthy.
              </p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refetch()}
                    disabled={isFetching}
                    className="h-7 w-full text-xs"
                  >
                    <RefreshCw
                      className={cn(
                        "mr-1.5 size-3",
                        isFetching && "animate-spin",
                      )}
                    />
                    Retry
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Retry loading ML pipeline data</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </AppShell>
      </TooltipProvider>
    );
  }

  const rungs = evaluateRungs(data);
  const refreshIntervalSec = data.training.modelsInTraining ? 3 : 15;

  return (
    <TooltipProvider delayDuration={150}>
      <AppShell
        title="ML Optimizer"
        titleBadge={<MLHeaderSummary data={data} rungs={rungs} />}
        edgeToEdge
        tabs={ML_WORKSPACE_TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        actions={
          <HeaderActions
            isFetching={isFetching}
            refreshIntervalSec={refreshIntervalSec}
            onRefresh={() => void refetch()}
          />
        }
      >
        <MLControlRoom data={data} rungs={rungs} />
      </AppShell>
      <Toaster richColors closeButton position="bottom-right" />
    </TooltipProvider>
  );
}

function HeaderActions({
  isFetching,
  refreshIntervalSec,
  onRefresh,
}: {
  isFetching: boolean;
  refreshIntervalSec: number;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "hidden items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground sm:inline-flex",
          isFetching && "text-cyan-400",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full bg-emerald-400",
            isFetching && "bg-cyan-400 animate-pulse",
          )}
        />
        {isFetching ? "Refreshing..." : `Auto-refresh ${refreshIntervalSec}s`}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
            className="h-7 text-xs"
            aria-label="Refresh ML pipeline"
          >
            <RefreshCw
              className={cn("mr-1.5 size-3", isFetching && "animate-spin")}
            />
            Refresh
          </Button>
        </TooltipTrigger>
        <TooltipContent>Refresh ML pipeline data</TooltipContent>
      </Tooltip>
    </div>
  );
}
