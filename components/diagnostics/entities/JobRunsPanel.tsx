"use client";

/**
 * Job runs tab — entity-resolver Cloud Run Job execution history with
 * live progress for any in-flight run.
 *
 *   • Active-run card on top: current pass, elapsed time, per-pass
 *     progress (embeddings/splink/leiden/retrain), polls every 2 s.
 *   • Past-runs DataTable below: status, duration, summary stats.
 *   • "Trigger cleanup Job" button if no run is active.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  ChevronRight,
  CircleX,
  GitMerge,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fetchActiveRun, fetchRuns, triggerResolverJob } from "./api";
import {
  EmptyHint,
  KpiCard,
  RunStatusPill,
  durationLabel,
  relativeTime,
} from "./atoms";
import type { ResolverRunRow } from "./types";

const PASSES = ["embedding-backfill", "splink", "leiden", "retrain"] as const;

const PASS_LABELS: Record<string, string> = {
  startup: "Booting Job container",
  "embedding-backfill": "Embedding backfill",
  splink: "Splink record linkage",
  leiden: "Leiden community detection",
  retrain: "Classifier retrain",
};

const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;

export function JobRunsPanel() {
  const [runs, setRuns] = useState<ResolverRunRow[]>([]);
  const [active, setActive] = useState<ResolverRunRow | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, act] = await Promise.all([fetchRuns(50), fetchActiveRun()]);
      setRuns(list);
      setActive(act);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Adaptive polling: while active, hit every 2s; when idle, every 15s.
  useEffect(() => {
    const interval = active ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const t = setInterval(() => {
      void refresh();
    }, interval);
    return () => clearInterval(t);
  }, [active, refresh]);

  const onTrigger = async () => {
    const r = await triggerResolverJob();
    if (r.error) {
      toast.error("Trigger failed", { description: r.error });
      return;
    }
    toast.success("Cleanup Job triggered", { description: `Run ${r.runId}` });
    await refresh();
  };

  const columns = useMemo<ColumnDef<ResolverRunRow, unknown>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: "When",
        cell: (c) => relativeTime(c.getValue() as string),
        meta: { initialSize: 100, align: "right" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: (c) => (
          <RunStatusPill status={c.getValue() as ResolverRunRow["status"]} />
        ),
        meta: { initialSize: 100, align: "center" },
      },
      {
        accessorKey: "triggerSource",
        header: "Trigger",
        cell: (c) => (
          <span className="text-[10px] text-zinc-400">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: { initialSize: 80 },
      },
      {
        accessorKey: "currentPass",
        header: "Pass",
        cell: (c) => (
          <span className="text-[10px] text-zinc-400">
            {String(c.getValue() ?? "—")}
          </span>
        ),
        meta: { initialSize: 160 },
      },
      {
        accessorKey: "durationMs",
        header: "Duration",
        cell: (c) => durationLabel(c.getValue() as number | null),
        meta: { initialSize: 90, align: "right" },
      },
      {
        id: "summary",
        header: "Summary",
        accessorFn: (r) => JSON.stringify(r.summary ?? {}),
        cell: (c) => {
          const s = c.row.original.summary as Record<string, unknown>;
          if (!s || Object.keys(s).length === 0) {
            return <span className="text-zinc-700">—</span>;
          }
          const parts: string[] = [];
          if (typeof s.embeddings_written === "number")
            parts.push(`emb ${s.embeddings_written}`);
          if (typeof s.splink_merges === "number")
            parts.push(`merge ${s.splink_merges}`);
          if (typeof s.splink_splits === "number")
            parts.push(`split ${s.splink_splits}`);
          if (typeof s.splink_conflicts === "number")
            parts.push(`conflict ${s.splink_conflicts}`);
          if (typeof s.leiden_suggestions === "number")
            parts.push(`leiden ${s.leiden_suggestions}`);
          return (
            <span className="text-[10px] text-zinc-400 font-mono">
              {parts.join(" · ") || "—"}
            </span>
          );
        },
        meta: { initialSize: 320 },
      },
      {
        accessorKey: "error",
        header: "",
        cell: (c) => {
          const e = c.getValue() as string | null;
          return e ? (
            <CircleX className="w-3.5 h-3.5 text-rose-400" aria-label={e} />
          ) : null;
        },
        meta: { initialSize: 30, align: "center" },
      },
    ],
    [],
  );

  return (
    <div className="h-full flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/50">
        <div className="text-[11px] text-zinc-500">
          {runs.length} historical run{runs.length === 1 ? "" : "s"}
          {active && (
            <span className="ml-2 text-sky-300">
              · 1 active (polling every {ACTIVE_POLL_MS / 1000}s)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={loading}
            className="h-7 text-[11px]"
          >
            <RefreshCw
              className={loading ? "w-3 h-3 animate-spin" : "w-3 h-3"}
            />
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={onTrigger}
            disabled={!!active}
            className="h-7 text-[11px] bg-violet-600 hover:bg-violet-700"
          >
            <GitMerge className="w-3 h-3 mr-1.5" />
            {active ? "Cleanup running…" : "Trigger cleanup Job"}
          </Button>
        </div>
      </div>

      {active && <ActiveRunCard run={active} />}

      <div className="flex-1 min-h-0">
        {runs.length === 0 && !loading ? (
          <EmptyHint
            title="No runs yet"
            description='Click "Trigger cleanup Job" to fire the entity-resolver pipeline (Splink + Leiden + retrain).'
          />
        ) : (
          <DataTable
            data={runs}
            columns={columns}
            getRowId={(r) => r.id}
            enableSorting
            enableColumnResizing
            enableVirtualization
            persistenceKey="job-runs-table"
            density="compact"
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}

function ActiveRunCard({ run }: { run: ResolverRunRow }) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const startedMs = run.startedAt ? Date.parse(run.startedAt) : null;
  const elapsedMs = startedMs ? now - startedMs : 0;

  const currentPassIdx = (() => {
    if (!run.currentPass) return -1;
    const i = PASSES.indexOf(run.currentPass as (typeof PASSES)[number]);
    return i >= 0 ? i : -1;
  })();

  const progress = run.progress ?? {};
  const v = (k: string) => progress[k] as number | string | undefined;

  return (
    <div className="m-3 rounded border border-sky-700/50 bg-sky-950/30 p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          {run.status === "running" ? (
            <Activity className="w-4 h-4 text-sky-400 animate-pulse" />
          ) : (
            <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
          )}
          <div>
            <div className="text-sm font-semibold text-zinc-100">
              {run.status === "running"
                ? "Cleanup Job in flight"
                : "Run queued"}
            </div>
            <div className="text-[10px] text-zinc-500 font-mono">
              {run.id} · {run.cloudRunExecution ?? "no execution name yet"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RunStatusPill status={run.status} />
          <div className="text-[11px] text-zinc-400 tabular-nums">
            {durationLabel(elapsedMs)} elapsed
          </div>
        </div>
      </div>

      {/* Pass progress strip */}
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {PASSES.map((pass, i) => {
          const state =
            currentPassIdx > i
              ? "done"
              : currentPassIdx === i
                ? "active"
                : "pending";
          const tone =
            state === "done"
              ? "bg-emerald-900/40 text-emerald-300 border-emerald-700/40"
              : state === "active"
                ? "bg-sky-900/40 text-sky-200 border-sky-600/60"
                : "bg-zinc-900/40 text-zinc-600 border-zinc-800/60";
          return (
            <div
              key={pass}
              className={cn(
                "rounded border px-2 py-1.5 flex items-center gap-1.5",
                tone,
              )}
            >
              {state === "done" && <span className="text-emerald-400">✓</span>}
              {state === "active" && (
                <Loader2 className="w-3 h-3 animate-spin" />
              )}
              {state === "pending" && (
                <ChevronRight className="w-3 h-3 opacity-50" />
              )}
              <span className="text-[10px] uppercase font-medium">
                {PASS_LABELS[pass] ?? pass}
              </span>
            </div>
          );
        })}
      </div>

      {/* Live counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <KpiCard
          label="Embeddings written"
          value={String(v("embeddings_written") ?? 0)}
        />
        <KpiCard
          label="Splink merges"
          value={String(v("splink_merges") ?? 0)}
          tone="good"
        />
        <KpiCard
          label="Splink splits"
          value={String(v("splink_splits") ?? 0)}
          tone="warn"
        />
        <KpiCard
          label="Splink conflicts"
          value={String(v("splink_conflicts") ?? 0)}
          tone="bad"
        />
        <KpiCard
          label="Leiden suggestions"
          value={String(v("leiden_suggestions") ?? 0)}
        />
        <KpiCard
          label="Retrain"
          value={
            <span className="text-[11px]">
              {(v("retrain_result") as string)?.slice(0, 28) ?? "—"}
            </span>
          }
        />
        <KpiCard
          label="Started"
          value={<span className="text-sm">{relativeTime(run.startedAt)}</span>}
        />
        <KpiCard
          label="Trigger"
          value={
            <span className="text-sm">
              {run.triggerSource}
              {run.triggeredBy && (
                <span className="text-zinc-500 text-[10px]">
                  {" "}
                  · {run.triggeredBy}
                </span>
              )}
            </span>
          }
        />
      </div>

      {run.error && (
        <div className="mt-3 text-[11px] text-rose-300 bg-rose-950/30 border border-rose-700/40 rounded p-2 font-mono">
          {run.error}
        </div>
      )}
    </div>
  );
}
