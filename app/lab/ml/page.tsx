"use client";

import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Database,
  FlaskConical,
  Layers,
  RefreshCw,
} from "lucide-react";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { ActivityFeed } from "@/components/lab/ml/ActivityFeed";
import { MLHeroBanner } from "@/components/lab/ml/MLHeroBanner";
import { MLOverviewStrip } from "@/components/lab/ml/MLOverviewStrip";
import { MLPageSkeleton } from "@/components/lab/ml/MLPageSkeleton";
import { ModelTimeMachine } from "@/components/lab/ml/ModelTimeMachine";
import { PipelineLadder } from "@/components/lab/ml/PipelineLadder";
import { RejectedModelsCard } from "@/components/lab/ml/RejectedModelsCard";
import { WhatIfProbe } from "@/components/lab/ml/WhatIfProbe";
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

type TabValue = "pipeline" | "models" | "probe";

export default function MLLabPage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    usePipeline();
  const [tab, setTab] = useState<TabValue>("pipeline");

  // Hero CTA — switch to the Pipeline tab and scroll to the first failing rung.
  const jumpToFailingGate = useCallback(() => {
    setTab("pipeline");
    // Scroll happens after the tab content is rendered.
    requestAnimationFrame(() => {
      const rungs = data ? evaluateRungs(data) : [];
      const failing = rungs.find((r) => r.verdict.status === "fail");
      if (failing) {
        const el = document.getElementById(`rung-${failing.definition.number}`);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }, [data]);

  if (isLoading) {
    return (
      <TooltipProvider delayDuration={150}>
        <AppShell title="ML Optimizer" edgeToEdge>
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
            <div className="max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/10 p-5 backdrop-blur-xl text-center">
              <AlertTriangle className="size-6 text-rose-400 mx-auto mb-2" />
              <h2 className="text-sm font-bold uppercase text-rose-400 mb-1">
                Pipeline endpoint offline
              </h2>
              <p className="text-[13px] text-foreground/70 mb-3">
                <code>/api/ml/pipeline</code> failed. Verify Cloud SQL and the
                engine.
              </p>
              <div className="rounded-lg bg-background/50 border border-white/10 p-2 font-mono text-[11px] text-rose-300/90 truncate mb-3">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="h-7 text-xs w-full"
              >
                <RefreshCw
                  className={cn("mr-1.5 size-3", isFetching && "animate-spin")}
                />
                Retry
              </Button>
            </div>
          </div>
        </AppShell>
      </TooltipProvider>
    );
  }

  const rungs = evaluateRungs(data);
  const refreshIntervalSec = data.training.modelsInTraining ? 3 : 15;
  const failingCount = rungs.filter((r) => r.verdict.status === "fail").length;
  const rejectedCount = (data.rejectedModels ?? []).length;
  const trainedCount = (data.modelHistory ?? []).filter(
    (m) => m.version > 0,
  ).length;

  return (
    <TooltipProvider delayDuration={150}>
      <AppShell
        title="ML Optimizer"
        edgeToEdge
        actions={
          <HeaderActions
            isFetching={isFetching}
            refreshIntervalSec={refreshIntervalSec}
            onRefresh={() => void refetch()}
          />
        }
      >
        <div className="flex flex-1 flex-col bg-background overflow-hidden text-foreground">
          <div className="flex-1 overflow-y-auto">
            <div className="w-full px-4 py-4 space-y-4 xl:px-6 2xl:px-8">
              {/* Hero state — always visible, scan-first */}
              <MLHeroBanner
                data={data}
                rungs={rungs}
                onJumpToFailingGate={
                  failingCount > 0 ? jumpToFailingGate : undefined
                }
              />

              {/* KPI strip — always visible */}
              <MLOverviewStrip data={data} rungs={rungs} />

              {/* Tabs — focused operational views */}
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as TabValue)}
                className="gap-4"
              >
                <TabsList variant="line" className="h-9 bg-transparent p-0">
                  <TabsTrigger value="pipeline" className="gap-1.5 px-3">
                    <Layers className="size-3.5" />
                    Pipeline
                    {failingCount > 0 && (
                      <span className="ml-1 inline-flex size-4 items-center justify-center rounded-full bg-rose-500/20 text-[10px] font-semibold text-rose-400">
                        {failingCount}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="models" className="gap-1.5 px-3">
                    <Database className="size-3.5" />
                    Models
                    {trainedCount > 0 && (
                      <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                        {trainedCount}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="probe" className="gap-1.5 px-3">
                    <FlaskConical className="size-3.5" />
                    What-If Probe
                  </TabsTrigger>
                </TabsList>

                <TabsContent
                  value="pipeline"
                  className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]"
                >
                  <PipelineLadder data={data} rungs={rungs} />
                  <ActivityFeed data={data} />
                </TabsContent>

                <TabsContent
                  value="models"
                  className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
                >
                  <ModelTimeMachine data={data} />
                  <RejectedModelsCard data={data} />
                  {rejectedCount === 0 && trainedCount === 0 && (
                    <p className="col-span-full text-center text-[12.5px] text-muted-foreground">
                      Once the first training run completes, model history and
                      rejection reasons appear here.
                    </p>
                  )}
                </TabsContent>

                <TabsContent value="probe">
                  <WhatIfProbe data={data} />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
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
          "hidden items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground sm:inline-flex",
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
