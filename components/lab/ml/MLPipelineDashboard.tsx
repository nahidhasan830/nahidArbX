"use client";

/**
 * ML Optimizer Dashboard — compact guided operator layout.
 *
 * Split into composable sub-modules under panels/ and tabs/ for maintainability.
 */

import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  LayoutDashboard,
  LineChart,
  RefreshCw,
} from "lucide-react";
import { TabsContent } from "@/components/ui/tabs";
import { AppShell } from "@/components/nav/AppShell";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RetrainButton } from "./MLModelStatus";
import { useMLTrainingStream } from "@/components/hooks/useMLTrainingStream";
import { OverviewTab } from "./tabs/OverviewTab";
import { PaperTradingTab } from "./tabs/PaperTradingTab";
import { getStageStatuses } from "./shared";

// Re-export types so existing imports from this file still work
export type { PipelineData, StageStatus } from "./types";
import type { PipelineData } from "./types";

// ── Query ─────────────────────────────────────────────────────────────

export function usePipeline() {
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

// ── Main Dashboard ────────────────────────────────────────────────────

export function MLPipelineDashboard() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    usePipeline();
  const [activeTab, setActiveTab] = useState<string>("overview");
  const trainingStream = useMLTrainingStream();
  const qc = useQueryClient();

  // Hydrate training state from polled pipeline data (persists across page refresh)
  const activeTraining = data?.training?.activeTraining;
  useEffect(() => {
    trainingStream.hydrateFromPipeline(activeTraining ?? null);
  }, [activeTraining]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refetch pipeline + model data when training reaches a terminal state
  const terminalPhase = trainingStream.currentTraining?.phase;
  const terminalModelId = trainingStream.currentTraining?.modelId;
  const prevTerminalRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      terminalPhase &&
      ["completed", "failed", "rejected"].includes(terminalPhase) &&
      terminalModelId !== prevTerminalRef.current
    ) {
      prevTerminalRef.current = terminalModelId ?? null;
      // Refetch pipeline diagnostics and model history
      void refetch();
      void qc.invalidateQueries({ queryKey: ["ml"] });
    }
  }, [terminalPhase, terminalModelId, refetch, qc]);

  if (isLoading) {
    return (
      <AppShell title="ML Optimizer" edgeToEdge>
        <div className="flex flex-1 items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3">
            <div className="size-8 rounded-full border-2 border-cyan-500/20 border-t-cyan-500 animate-spin" />
            <p className="text-cyan-500/70 font-mono text-[10px] uppercase tracking-widest animate-pulse">
              Booting...
            </p>
          </div>
        </div>
      </AppShell>
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
                System Offline
              </h2>
              <p className="text-[11px] text-white/70 mb-3">
                `/api/ml/pipeline` failed. Verify DB & engine.
              </p>
              <div className="rounded-lg bg-background/50 border border-white/10 p-2 font-mono text-[10px] text-rose-300/90 truncate mb-3">
                {error instanceof Error ? error.message : "Unknown error"}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="h-7 text-xs border-white/10 hover:bg-white/10 text-white w-full"
              >
                <RefreshCw
                  className={cn("mr-1.5 size-3", isFetching && "animate-spin")}
                />{" "}
                Retry Connection
              </Button>
            </div>
          </div>
        </AppShell>
      </TooltipProvider>
    );
  }

  const statuses = getStageStatuses(data);

  const isTraining =
    trainingStream.isTraining || data.training.modelsInTraining > 0;
  const coldReady =
    data.dataCollection.qualifiedForTraining >=
    data.dataCollection.coldStartThreshold;
  const trainingDisabledReason = !coldReady
    ? `${Math.max(
        0,
        data.dataCollection.coldStartThreshold -
          data.dataCollection.qualifiedForTraining,
      )} more settled examples needed before training can start.`
    : undefined;
  const growthThresholdPct = data.scheduler.growthThresholdPct;

  const headerActions = (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="hidden sm:inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-300 cursor-help">
            <span className="size-1.5 rounded-full bg-cyan-400" />
            Auto-retrain ≥{growthThresholdPct}% data growth
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-sm leading-relaxed">
          A new training run kicks off automatically as soon as the canonical
          training corpus has grown by ≥{growthThresholdPct}% since the last
          deployed model. There is no cadence or schedule — manual retrain is
          always available via the button on the right.
        </TooltipContent>
      </Tooltip>
      <RetrainButton
        size="sm"
        hasExistingModel={data.training.totalModels > 0}
        disabledReason={trainingDisabledReason}
        isTraining={isTraining}
        trainingVersion={
          trainingStream.currentTraining?.version ??
          data.training.activeTraining?.version
        }
      />
    </div>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <AppShell
        title="ML Optimizer"
        edgeToEdge
        actions={headerActions}
        tabs={[
          { value: "overview", label: "Overview", icon: LayoutDashboard },
          { value: "paper-trading", label: "Paper Trading", icon: LineChart },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        <div className="relative flex flex-col flex-1 min-h-0 bg-background overflow-hidden text-foreground">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden" />

          <div className="relative z-10 flex flex-col flex-1 min-h-0 p-3 max-w-[1920px] mx-auto w-full">
            <TabsContent
              value="overview"
              className="flex-1 min-h-0 mt-0 outline-none"
            >
              <OverviewTab
                data={data}
                statuses={statuses}
                trainingStream={trainingStream}
              />
            </TabsContent>
            <TabsContent
              value="paper-trading"
              className="flex-1 min-h-0 mt-0 outline-none"
            >
              <PaperTradingTab />
            </TabsContent>
          </div>
        </div>
      </AppShell>
    </TooltipProvider>
  );
}
