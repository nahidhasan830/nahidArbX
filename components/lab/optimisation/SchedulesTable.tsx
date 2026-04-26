"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  describeFrequency,
  type Frequency,
  type OptimizationScheduleRow,
} from "@/lib/optimizer/schedule-types";

const REFRESH_MS = 10_000;

async function fetchSchedules(): Promise<{
  schedules: OptimizationScheduleRow[];
}> {
  const res = await fetch("/api/optimizer/schedules", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function SchedulesTable() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["optimizer", "schedules"],
    queryFn: fetchSchedules,
    refetchInterval: REFRESH_MS,
  });

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/optimizer/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["optimizer", "schedules"] }),
    onError: (e: Error) => toast.error(`Toggle failed: ${e.message}`),
  });

  const [runningId, setRunningId] = React.useState<string | null>(null);

  const runNow = useMutation({
    mutationFn: async (id: string) => {
      setRunningId(id);
      const res = await fetch(`/api/optimizer/schedules/${id}/run-now`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      toast.success("Manual run queued");
      qc.invalidateQueries({ queryKey: ["optimizer", "runs"] });
    },
    onSettled: () => setRunningId(null),
    onError: (e: Error) => toast.error(`Run-now failed: ${e.message}`),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/optimizer/schedules/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      toast.success("Schedule deleted");
      qc.invalidateQueries({ queryKey: ["optimizer", "schedules"] });
    },
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground py-4">Loading schedules…</p>
    );
  }
  if (isError) {
    return (
      <p className="text-xs text-red-500 py-4">
        {error instanceof Error ? error.message : "Failed to load schedules"}
      </p>
    );
  }
  const schedules = data?.schedules ?? [];
  if (schedules.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-sm text-muted-foreground">No schedules yet</p>
        <p className="text-[11px] text-muted-foreground">
          Click <span className="font-medium">New schedule</span> to set up
          recurring runs (e.g. a daily 3am sweep on the latest data).
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
            <th className="px-3 py-2 font-medium">Frequency</th>
            <th className="px-3 py-2 font-medium">Last fired</th>
            <th className="px-3 py-2 font-medium">Next fires</th>
            <th className="px-3 py-2 font-medium text-center">Enabled</th>
            <th className="px-3 py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => {
            const freq = s.frequency as unknown as Frequency;
            return (
              <tr
                key={s.id}
                className="border-t border-border/60 hover:bg-muted/20"
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{s.name}</div>
                  {s.description && (
                    <div className="text-[10px] text-muted-foreground">
                      {s.description}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {describeFrequency(freq, s.timezone)}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {s.lastFireAt
                    ? formatDistanceToNow(new Date(s.lastFireAt), {
                        addSuffix: true,
                      })
                    : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatDistanceToNow(new Date(s.nextFireAt), {
                    addSuffix: true,
                  })}
                </td>
                <td className="px-3 py-2 text-center">
                  <Checkbox
                    checked={s.enabled}
                    onCheckedChange={(v) =>
                      toggleEnabled.mutate({ id: s.id, enabled: v === true })
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => runNow.mutate(s.id)}
                      disabled={runningId === s.id}
                      title="Run now (manual fire — does not affect schedule)"
                    >
                      {runningId === s.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-red-500"
                      onClick={() => {
                        if (confirm(`Delete schedule "${s.name}"?`))
                          remove.mutate(s.id);
                      }}
                      disabled={remove.isPending}
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
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
