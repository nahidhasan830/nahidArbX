"use client";

/**
 * Observations tab — append-only audit log of every match attempt.
 * Filters: source / outcome / provider / search. Live-updates every
 * 15 s while open.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchObservations } from "./api";
import { EmptyHint, OutcomePill, relativeTime } from "./atoms";
import type { ObservationRow } from "./types";

const SOURCES = ["all", "harvester", "match-review", "learner", "settle"];
const OUTCOMES = [
  "all",
  "matched",
  "rejected",
  "near-match",
  "manual-confirm",
  "manual-reject",
];

export function ObservationsPanel() {
  const [source, setSource] = useState("all");
  const [outcome, setOutcome] = useState("all");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ObservationRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(
        await fetchObservations({
          source: source === "all" ? undefined : source,
          outcome: outcome === "all" ? undefined : outcome,
          search,
          limit: 1000,
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [source, outcome, search]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const columns = useMemo<ColumnDef<ObservationRow, unknown>[]>(
    () => [
      {
        accessorKey: "observedAt",
        header: "When",
        cell: (c) => relativeTime(c.getValue() as string),
        meta: { initialSize: 90, align: "right" },
      },
      {
        accessorKey: "surfaceRaw",
        header: "Surface",
        cell: (c) => {
          const r = c.row.original;
          return (
            <div>
              <div className="text-zinc-200">{r.surfaceRaw}</div>
              <div className="text-[9px] text-zinc-600 font-mono">
                {r.surfaceNormalized}
              </div>
            </div>
          );
        },
        meta: { initialSize: 220 },
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: (c) => (
          <span className="font-mono text-[10px] text-zinc-400">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: { initialSize: 130 },
      },
      {
        accessorKey: "outcome",
        header: "Outcome",
        cell: (c) => <OutcomePill outcome={c.getValue() as string} />,
        meta: { initialSize: 110, align: "center" },
      },
      {
        accessorKey: "source",
        header: "Source",
        cell: (c) => (
          <span className="text-[10px] text-zinc-400">
            {String(c.getValue() ?? "")}
          </span>
        ),
        meta: { initialSize: 100 },
      },
      {
        accessorKey: "matchScore",
        header: "Match",
        cell: (c) => {
          const v = c.getValue() as number | null;
          return v == null ? "—" : v.toFixed(3);
        },
        meta: { initialSize: 70, align: "right" },
      },
      {
        accessorKey: "classifierScore",
        header: "Score",
        cell: (c) => {
          const v = c.getValue() as number | null;
          if (v == null) return "—";
          const tone =
            v >= 0.92
              ? "text-emerald-300"
              : v >= 0.5
                ? "text-amber-300"
                : "text-zinc-500";
          return (
            <span className={cn("tabular-nums", tone)}>{v.toFixed(3)}</span>
          );
        },
        meta: { initialSize: 70, align: "right" },
      },
      {
        accessorKey: "pairedWithEntityId",
        header: "Bound to",
        cell: (c) => {
          const v = c.getValue() as string | null;
          return v ? (
            <span className="font-mono text-[10px] text-zinc-500">{v}</span>
          ) : (
            <span className="text-zinc-700">—</span>
          );
        },
        meta: { initialSize: 220 },
      },
    ],
    [],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800/50">
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="h-7 text-[11px] bg-muted/40 border border-zinc-700/50 rounded px-2"
        >
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All sources" : s}
            </option>
          ))}
        </select>
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          className="h-7 text-[11px] bg-muted/40 border border-zinc-700/50 rounded px-2"
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o === "all" ? "All outcomes" : o}
            </option>
          ))}
        </select>
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2 top-2 w-3.5 h-3.5 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search surface…"
            className="h-7 pl-7 text-xs bg-muted/40 border-zinc-700/50"
          />
        </div>
        <div className="text-[11px] text-zinc-500 ml-auto">
          {items.length} obs · refreshes every 15s
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {items.length === 0 && !loading ? (
          <EmptyHint
            title="No observations match"
            description="Widen the filters or wait for the next sync to log new attempts."
          />
        ) : (
          <DataTable
            data={items}
            columns={columns}
            getRowId={(r) => String(r.id)}
            enableSorting
            enableColumnResizing
            enableVirtualization
            persistenceKey="observations-table"
            density="compact"
            loading={loading}
          />
        )}
      </div>
    </div>
  );
}
