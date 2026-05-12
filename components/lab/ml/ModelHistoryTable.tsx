"use client";

/**
 * Model History — compact version comparison table using DataTable.
 *
 * Shows the last N models with plain-English quality checks, sample count,
 * status, and trend indicators so operators can see whether models improve.
 */

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { TrendingUp, TrendingDown, Minus, Crown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ModelHistoryEntry {
  version: number;
  status: string;
  trainingSamples: number;
  oosAucRoc: number | null;
  deflatedSharpe: number | null;
  pbo: number | null;
  permissionLevel: string | null;
  rejectionReasons: string[] | null;
  deployedAt: string | null;
  createdAt: string | null;
}

interface ModelHistoryTableProps {
  models: ModelHistoryEntry[];
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  deployed: {
    label: "Active",
    className: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
  retired: {
    label: "Retired",
    className: "bg-white/5 text-white/40 border-white/10",
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-500/15 text-red-300 border-red-500/20",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/15 text-red-300 border-red-500/20",
  },
};

function Trend({
  current,
  previous,
  higherIsBetter = true,
}: {
  current: number | null;
  previous: number | null;
  higherIsBetter?: boolean;
}) {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 0.001) {
    return <Minus className="size-3 text-white/20 inline" />;
  }
  const improving = higherIsBetter ? diff > 0 : diff < 0;
  return improving ? (
    <TrendingUp className="size-3 text-emerald-400 inline" />
  ) : (
    <TrendingDown className="size-3 text-amber-400 inline" />
  );
}

export function ModelHistoryTable({ models }: ModelHistoryTableProps) {
  // Sort by version descending for display
  const sorted = useMemo(
    () => [...models].sort((a, b) => b.version - a.version),
    [models],
  );

  // Build a lookup map: version → previous model (the one right before it)
  const prevMap = useMemo(() => {
    const map = new Map<number, ModelHistoryEntry>();
    for (let i = 0; i < sorted.length - 1; i++) {
      map.set(sorted[i].version, sorted[i + 1]);
    }
    return map;
  }, [sorted]);

  const columns: ColumnDef<ModelHistoryEntry, unknown>[] = useMemo(
    () => [
      {
        id: "version",
        header: "Version",
        meta: {
          hint: "The version number of this model. Higher = newer.",
        },
        accessorFn: (row) => row.version,
        cell: ({ row }) => {
          const isActive = row.original.status === "deployed";
          return (
            <span
              className={cn(
                "font-mono font-semibold",
                isActive ? "text-emerald-300" : "text-white/70",
              )}
            >
              v{row.original.version}
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        meta: {
          hint: "Active = currently in use.\nRetired = replaced by a newer model.\nRejected = didn't pass quality checks.",
        },
        accessorFn: (row) => row.status,
        cell: ({ row }) => {
          const badge =
            STATUS_BADGE[row.original.status] ?? STATUS_BADGE.retired;
          const reasons = row.original.rejectionReasons ?? [];
          const badgeEl = (
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                badge.className,
              )}
            >
              {badge.label}
            </span>
          );
          if (
            (row.original.status === "rejected" ||
              row.original.status === "failed") &&
            reasons.length > 0
          ) {
            return (
              <Tooltip>
                <TooltipTrigger asChild>{badgeEl}</TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-pre-line text-sm">
                  {reasons.join("\n")}
                </TooltipContent>
              </Tooltip>
            );
          }
          return badgeEl;
        },
      },
      {
        id: "samples",
        header: "Samples",
        meta: {
          align: "right" as const,
          hint: "How many settled bets the model learned from.\nMore data usually means better predictions.",
        },
        accessorFn: (row) => row.trainingSamples,
        cell: ({ row }) => (
          <span className="text-white/70">
            {row.original.trainingSamples.toLocaleString()}
          </span>
        ),
      },
      {
        id: "auc",
        header: "Separation",
        meta: {
          align: "right" as const,
          hint: "How well the model ranks better bets above worse bets.\n0.50 = no better than guessing, 1.00 = perfect.\nAbove 0.55 is useful. Arrow shows trend vs previous version.",
        },
        accessorFn: (row) => row.oosAucRoc,
        cell: ({ row }) => {
          const val = row.original.oosAucRoc;
          const prev = prevMap.get(row.original.version);
          if (val == null) return <span className="text-white/20">—</span>;
          return (
            <span className="inline-flex items-center gap-1 text-white/70">
              <span className="tabular-nums">{val.toFixed(4)}</span>
              <Trend
                current={val}
                previous={prev?.oosAucRoc ?? null}
                higherIsBetter
              />
            </span>
          );
        },
      },
      {
        id: "sharpe",
        header: "Luck Check",
        meta: {
          align: "right" as const,
          hint: "A return score that discounts lucky-looking results after trying many model settings.\nHigher is better. Below 0 means the model lost money on hidden checks.",
        },
        accessorFn: (row) => row.deflatedSharpe,
        cell: ({ row }) => {
          const val = row.original.deflatedSharpe;
          const prev = prevMap.get(row.original.version);
          if (val == null) return <span className="text-white/20">—</span>;
          return (
            <span className="inline-flex items-center gap-1 text-white/70">
              <span className="tabular-nums">{val.toFixed(3)}</span>
              <Trend
                current={val}
                previous={prev?.deflatedSharpe ?? null}
                higherIsBetter
              />
            </span>
          );
        },
      },
      {
        id: "pbo",
        header: "Memory Risk",
        meta: {
          align: "right" as const,
          hint: "The chance the model mostly memorized old results instead of learning a repeatable pattern.\nLower is better. Above 0.70 is a warning.",
        },
        accessorFn: (row) => row.pbo,
        cell: ({ row }) => {
          const val = row.original.pbo;
          const prev = prevMap.get(row.original.version);
          if (val == null) return <span className="text-white/20">—</span>;
          return (
            <span className="inline-flex items-center gap-1 text-white/70">
              <span className="tabular-nums">{val.toFixed(3)}</span>
              <Trend
                current={val}
                previous={prev?.pbo ?? null}
                higherIsBetter={false}
              />
            </span>
          );
        },
      },
    ],
    [prevMap],
  );

  if (sorted.length === 0) return null;

  return (
    <div className="px-3 pt-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Crown className="size-3.5 text-amber-400" />
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-white/80">
          Model history
        </h3>
        <span className="text-[10px] text-white/30">
          {sorted.length} versions
        </span>
      </div>

      <DataTable
        data={sorted}
        columns={columns}
        getRowId={(row) => String(row.version)}
        density="compact"
        enableVirtualization={false}
        enableSorting={false}
        rowClassName={(row) =>
          row.status === "deployed"
            ? "bg-emerald-500/[0.04]"
            : undefined
        }
      />
    </div>
  );
}
