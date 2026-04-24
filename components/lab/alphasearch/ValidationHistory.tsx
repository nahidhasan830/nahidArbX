"use client";

/**
 * Inline validation-history mini-table shown when the user expands a row in
 * the Strategies tab. Renders the most recent 50 auto-validation checks
 * with a drift trend (green/amber/red dots) + an audit note for any
 * auto-pause events.
 */

import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { TermTooltip } from "@/components/ui/TermTooltip";

interface ValidationRow {
  id: string;
  ranAt: string;
  nSettled: number;
  liveRoiPct: number | null;
  snapshotRoiMean: number | null;
  snapshotRoiCiLow: number | null;
  snapshotRoiCiHigh: number | null;
  driftFlag: boolean;
  consecutiveDrifts: number;
  triggeredAutoPause: boolean;
  note: string | null;
}

async function fetchValidations(
  id: string,
): Promise<{ validations: ValidationRow[] }> {
  const res = await fetch(`/api/optimizer/strategies/${id}/validations`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const fmt = (n: number | null, digits = 2): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
};

export function ValidationHistory({ strategyId }: { strategyId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["optimizer", "validations", strategyId],
    queryFn: () => fetchValidations(strategyId),
    staleTime: 30_000,
  });

  if (isLoading) {
    return <p className="text-[10px] text-muted-foreground py-1">Loading…</p>;
  }
  const rows = data?.validations ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-[10px] text-muted-foreground py-1">
        No validation checks yet — first run fires within 1 hour of activation
        and weekly thereafter.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <TermTooltip term="auto_validation">
          Auto-validation history
        </TermTooltip>
        {" — most recent first"}
      </p>
      <div className="space-y-1">
        {rows.map((v) => {
          const dotColor = v.triggeredAutoPause
            ? "bg-red-500"
            : v.driftFlag
              ? "bg-amber-500"
              : "bg-emerald-500";
          return (
            <div
              key={v.id}
              className="flex items-center gap-2 text-[10px] tabular-nums"
            >
              <span
                className={`size-2 rounded-full shrink-0 ${dotColor}`}
                aria-hidden
              />
              <span className="text-muted-foreground w-32 shrink-0">
                {format(new Date(v.ranAt), "yyyy-MM-dd HH:mm")}
              </span>
              <span className="w-14 text-right">
                live {fmt(v.liveRoiPct, 1)}%
              </span>
              <span className="text-muted-foreground w-32">
                vs OOS [{fmt(v.snapshotRoiCiLow, 1)},{" "}
                {fmt(v.snapshotRoiCiHigh, 1)}]
              </span>
              <span className="w-12 text-muted-foreground">n={v.nSettled}</span>
              {v.driftFlag && (
                <span className="text-amber-600">
                  drift × {v.consecutiveDrifts}
                </span>
              )}
              {v.triggeredAutoPause && v.note && (
                <span
                  className="text-red-500 truncate max-w-[200px]"
                  title={v.note}
                >
                  ⚠ auto-paused
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
