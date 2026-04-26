"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TermTooltip } from "@/components/ui/TermTooltip";
import type { OptimizationRunRow } from "@/lib/optimizer/repository";
import { RunStatusBadge } from "./RunStatusBadge";

const REFRESH_MS = 5_000;

async function fetchRuns(): Promise<{ runs: OptimizationRunRow[] }> {
  const res = await fetch("/api/optimizer/runs", { cache: "no-store" });
  if (!res.ok) throw new Error(`Runs fetch failed: ${res.status}`);
  return res.json();
}

export function RunsTable() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["optimizer", "runs"],
    queryFn: fetchRuns,
    refetchInterval: REFRESH_MS,
  });

  const cancel = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(`/api/optimizer/runs/${runId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      toast.success("Cancellation requested");
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
    },
    onError: (e: Error) => toast.error(`Cancel failed: ${e.message}`),
  });

  const rerun = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(`/api/optimizer/runs/${runId}/rerun`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { run: { id: string } };
    },
    onSuccess: (data) => {
      toast.success("New run queued — opening it now");
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
      router.push(`/lab/optimisation/${data.run.id}`);
    },
    onError: (e: Error) => toast.error(`Rerun failed: ${e.message}`),
  });

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-4">Loading runs…</p>;
  }
  if (isError) {
    return (
      <p className="text-xs text-red-500 py-4">
        Failed to load runs:{" "}
        {error instanceof Error ? error.message : "unknown"}
      </p>
    );
  }
  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-sm text-muted-foreground">No runs yet</p>
        <p className="text-[11px] text-muted-foreground">
          Click <span className="font-medium">New run</span> in the toolbar to
          begin. The optimizer will test thousands of configurations on your
          historical bets to find the best one.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border/60">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr className="text-left">
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Algorithm</th>
            <th className="px-3 py-2 font-medium">Progress</th>
            <th className="px-3 py-2 font-medium text-right">
              <TermTooltip term="composite_score">Best score</TermTooltip>
            </th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const pct =
              r.nTrialsTarget > 0
                ? Math.round((r.nTrialsDone / r.nTrialsTarget) * 100)
                : 0;
            const summary =
              (r.summary as Record<string, unknown> | null) ?? null;
            const bestScore = summary?.["best_composite_score"];
            const isLive = r.status === "queued" || r.status === "running";
            const isTerminal =
              r.status === "completed" ||
              r.status === "failed" ||
              r.status === "cancelled";
            const cancelPending = cancel.isPending && cancel.variables === r.id;
            const rerunPending = rerun.isPending && rerun.variables === r.id;
            return (
              <tr
                key={r.id}
                className="border-t border-border/60 hover:bg-muted/20"
              >
                <td className="px-3 py-2">
                  <Link
                    href={`/lab/optimisation/${r.id}`}
                    className="font-medium text-primary hover:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <RunStatusBadge status={r.status} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {r.searchAlgorithm}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Progress value={pct} className="h-1.5 w-20" />
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {r.nTrialsDone}/{r.nTrialsTarget}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {typeof bestScore === "number" ? bestScore.toFixed(2) : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDistanceToNow(new Date(r.createdAt), {
                    addSuffix: true,
                  })}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    {isLive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] gap-1"
                        onClick={() => cancel.mutate(r.id)}
                        disabled={cancelPending}
                        title="Cancel run"
                      >
                        <X className="size-3" />
                        Cancel
                      </Button>
                    )}
                    {isTerminal && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] gap-1"
                        onClick={() => rerun.mutate(r.id)}
                        disabled={rerunPending}
                        title="Clone this run's config and start fresh"
                      >
                        <RotateCcw className="size-3" />
                        Rerun
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
