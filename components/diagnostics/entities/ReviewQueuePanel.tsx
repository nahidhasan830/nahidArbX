"use client";

/**
 * Review queue tab — Splink/Leiden findings (merge / split / conflict)
 * awaiting operator approval. Click Approve on a `merge` row to invoke
 * the entity-merge action; Reject just marks the queue row resolved.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, Filter, RefreshCw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { entitiesAction, fetchReviewQueue } from "./api";
import { EmptyHint, relativeTime } from "./atoms";
import type { ReviewQueueItem } from "./types";

const KIND_TONE: Record<ReviewQueueItem["kind"], string> = {
  merge: "bg-emerald-900/40 text-emerald-300",
  split: "bg-amber-900/40 text-amber-300",
  conflict: "bg-rose-900/40 text-rose-300",
};

export function ReviewQueuePanel({ onMutated }: { onMutated: () => void }) {
  const [kindFilter, setKindFilter] = useState<
    "all" | "merge" | "split" | "conflict"
  >("all");
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await fetchReviewQueue({
          resolved: false,
          kind: kindFilter === "all" ? undefined : kindFilter,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [kindFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resolveItem = useCallback(
    async (item: ReviewQueueItem, resolution: string) => {
      if (
        resolution === "approved-merged" &&
        item.entityIdA &&
        item.entityIdB
      ) {
        const merge = await entitiesAction({
          action: "merge",
          fromId: item.entityIdB,
          intoId: item.entityIdA,
        });
        if (!merge.success) {
          toast.error("Merge failed", { description: merge.error });
          return;
        }
      }
      const r = await entitiesAction({
        action: "resolve-queue",
        id: item.id,
        resolution,
      });
      if (!r.success) {
        toast.error("Resolve failed", { description: r.error });
        return;
      }
      toast.success(`Resolved as ${resolution}`);
      await refresh();
      onMutated();
    },
    [refresh, onMutated],
  );

  const columns = useMemo<ColumnDef<ReviewQueueItem, unknown>[]>(
    () => [
      {
        accessorKey: "kind",
        header: "Kind",
        cell: (c) => {
          const k = c.getValue() as ReviewQueueItem["kind"];
          return (
            <span
              className={cn(
                "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold",
                KIND_TONE[k],
              )}
            >
              {k}
            </span>
          );
        },
        meta: { initialSize: 90, align: "center" },
      },
      {
        accessorKey: "source",
        header: "Detected by",
        cell: (c) => (
          <span className="font-mono text-[10px] text-zinc-400">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: { initialSize: 120 },
      },
      {
        id: "pair",
        header: "Pair",
        accessorFn: (r) => `${r.entityIdA ?? ""} → ${r.entityIdB ?? ""}`,
        cell: (c) => {
          const r = c.row.original;
          return (
            <div className="font-mono text-[10px] text-zinc-300 truncate">
              <span className="text-zinc-500">{r.entityIdA ?? "—"}</span>
              <ArrowRight className="inline w-3 h-3 mx-1 text-zinc-600" />
              <span className="text-zinc-500">{r.entityIdB ?? "—"}</span>
            </div>
          );
        },
        meta: { initialSize: 460 },
      },
      {
        accessorKey: "probability",
        header: "P",
        cell: (c) => {
          const p = c.getValue() as number;
          const tone =
            p >= 0.99
              ? "text-emerald-300"
              : p >= 0.85
                ? "text-amber-300"
                : "text-zinc-400";
          return (
            <span className={cn("tabular-nums", tone)}>{p.toFixed(3)}</span>
          );
        },
        meta: { initialSize: 70, align: "right", hint: "Splink probability" },
      },
      {
        accessorKey: "createdAt",
        header: "Found",
        cell: (c) => relativeTime(c.getValue() as string),
        meta: { initialSize: 90, align: "right" },
      },
      {
        id: "actions",
        header: "Actions",
        accessorFn: () => "",
        cell: (c) => {
          const item = c.row.original;
          return (
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() =>
                  resolveItem(
                    item,
                    item.kind === "merge" ? "approved-merged" : "approved",
                  )
                }
                className="text-[10px] text-emerald-400 hover:text-emerald-300"
              >
                Approve
              </button>
              <button
                onClick={() => resolveItem(item, "rejected")}
                className="text-[10px] text-zinc-500 hover:text-rose-400"
              >
                Reject
              </button>
            </div>
          );
        },
        meta: { initialSize: 130, align: "right", fixed: "right" },
      },
    ],
    [resolveItem],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/50">
        <Filter className="w-3.5 h-3.5 text-zinc-500" />
        <div className="flex items-center bg-muted/40 rounded-md p-0.5">
          {(["all", "merge", "split", "conflict"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded font-medium",
                kindFilter === k
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500",
              )}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-zinc-500 ml-auto">
          {items.length} unresolved
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={refresh}
          className="h-7 text-[11px]"
        >
          <RefreshCw className={loading ? "w-3 h-3 animate-spin" : "w-3 h-3"} />
        </Button>
      </div>

      <div className="flex-1 min-h-0">
        {items.length === 0 && !loading ? (
          <EmptyHint
            title="Queue is empty"
            description="Splink + Leiden haven't found anything to review. Trigger the cleanup Job from Overview to look again."
          />
        ) : (
          <DataTable
            data={items}
            columns={columns}
            getRowId={(r) => r.id}
            enableSorting
            enableColumnResizing
            enableVirtualization
            persistenceKey="review-queue-table"
            density="compact"
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
