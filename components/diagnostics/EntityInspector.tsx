"use client";

/**
 * EntityInspector — Alias Learner operator console.
 *
 * Tabs:
 *   • Overview       — health KPIs + sparkline + classifier histogram
 *                       + active Job card
 *   • Entities       — DataTable of teams + competitions, click for drawer
 *   • Surface forms  — DataTable of every entity_names row, candidate-first
 *   • Observations   — append-only audit log, live-refreshing every 15 s
 *   • Review queue   — Splink/Leiden findings awaiting approval
 *   • Job runs       — entity-resolver Cloud Run Job history with live
 *                       progress for any in-flight execution
 *   • Playground     — read-only resolver/classifier probe + controlled
 *                       observation submission
 *
 * Each tab uses the shared `<DataTable>` for sorting, virtualization,
 * resizable columns and persisted layout. The header pulses when a
 * cleanup Job is in flight so the operator notices without leaving
 * whichever tab they're on.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Database,
  FlaskConical,
  GitMerge,
  History,
  LayoutDashboard,
  ListTree,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchActiveRun, fetchHealth } from "./entities/api";
import { EntitiesPanel } from "./entities/EntitiesPanel";
import { JobRunsPanel } from "./entities/JobRunsPanel";
import { ObservationsPanel } from "./entities/ObservationsPanel";
import { OverviewPanel } from "./entities/OverviewPanel";
import { PlaygroundPanel } from "./entities/PlaygroundPanel";
import { ReviewQueuePanel } from "./entities/ReviewQueuePanel";
import { SurfaceFormsPanel } from "./entities/SurfaceFormsPanel";
import type { ResolverRunRow } from "./entities/types";

type Tab =
  | "overview"
  | "entities"
  | "surface-forms"
  | "observations"
  | "review-queue"
  | "job-runs"
  | "playground";

interface TabDef {
  id: Tab;
  label: string;
  icon: typeof Activity;
}

const TABS: TabDef[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "entities", label: "Entities", icon: Database },
  { id: "surface-forms", label: "Surface forms", icon: ListTree },
  { id: "observations", label: "Observations", icon: ScrollText },
  { id: "review-queue", label: "Review queue", icon: GitMerge },
  { id: "job-runs", label: "Job runs", icon: History },
  { id: "playground", label: "Playground", icon: FlaskConical },
];

interface HeaderStats {
  entitiesActive: number;
  namesActive: number;
  namesCandidate: number;
  observations24h: number;
}

export function EntityInspector() {
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<HeaderStats | null>(null);
  const [activeRun, setActiveRun] = useState<ResolverRunRow | null>(null);

  const refreshHeader = useCallback(async () => {
    try {
      const [h, a] = await Promise.all([fetchHealth(), fetchActiveRun()]);
      setStats({
        entitiesActive: h.stats.entitiesActive,
        namesActive: h.stats.namesActive,
        namesCandidate: h.stats.namesCandidate,
        observations24h: h.stats.observations24h,
      });
      setActiveRun(a);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    // Async fetch — setStats fires after the await so the setState
    // is microtask-deferred, not synchronous in the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshHeader();
    const t = setInterval(() => {
      void refreshHeader();
    }, 10_000);
    return () => clearInterval(t);
  }, [refreshHeader]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-zinc-900/30 rounded-lg border border-zinc-800">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800/50">
        <div className="flex items-center gap-3">
          <Database className="w-4 h-4 text-zinc-500" />
          <div>
            <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
              Alias Learner
              {activeRun && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-sky-900/40 text-sky-300 border border-sky-700/40">
                  <Activity className="w-2.5 h-2.5 animate-pulse" /> Job{" "}
                  {activeRun.status}
                </span>
              )}
            </h2>
            <p className="text-[11px] text-zinc-500">
              Tournament-scoped Postgres entity store · 4-tier ML promoter ·
              Splink + Leiden weekly cleanup
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500 tabular-nums">
          {stats && (
            <>
              <Stat label="entities" value={stats.entitiesActive} />
              <Stat label="active surfaces" value={stats.namesActive} />
              <Stat
                label="candidate"
                value={stats.namesCandidate}
                tone="warn"
              />
              <Stat label="obs/24h" value={stats.observations24h} />
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={refreshHeader}
            className="h-7 w-7 p-0 text-zinc-500"
          >
            <RefreshCw className="w-3 h-3" />
          </Button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex items-center gap-1 px-3 py-1.5 border-b border-zinc-800/50 overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = tab === t.id;
          const isJobTab = t.id === "job-runs";
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "px-2.5 py-1 text-[11px] font-medium rounded-md flex items-center gap-1.5 whitespace-nowrap",
                isActive
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40",
                isJobTab && activeRun && "ring-1 ring-sky-600/50",
              )}
            >
              <Icon className="w-3 h-3" />
              {t.label}
              {isJobTab && activeRun && (
                <span className="ml-0.5 w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              )}
            </button>
          );
        })}
      </nav>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "overview" && (
          <OverviewPanel onJumpToRuns={() => setTab("job-runs")} />
        )}
        {tab === "entities" && <EntitiesPanel onMutated={refreshHeader} />}
        {tab === "surface-forms" && (
          <SurfaceFormsPanel onMutated={refreshHeader} />
        )}
        {tab === "observations" && <ObservationsPanel />}
        {tab === "review-queue" && (
          <ReviewQueuePanel onMutated={refreshHeader} />
        )}
        {tab === "job-runs" && <JobRunsPanel />}
        {tab === "playground" && <PlaygroundPanel />}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warn";
}) {
  return (
    <div className="flex items-baseline gap-1">
      <span
        className={cn(
          "font-semibold",
          tone === "warn" ? "text-amber-300" : "text-zinc-200",
        )}
      >
        {value}
      </span>
      <span className="opacity-60">{label}</span>
    </div>
  );
}

export default EntityInspector;
