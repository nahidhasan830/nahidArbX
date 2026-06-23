"use client";

import { cn } from "@/lib/utils";

export interface HeatmapCell {
  dow: number;
  hour: number;
  bets: number;
  stake: number;
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({
  cells,
  currency = "BDT",
}: {
  cells: HeatmapCell[];
  currency?: string;
}) {
  const grid: (HeatmapCell | null)[][] = Array.from({ length: 7 }, () =>
    Array(24).fill(null),
  );
  for (const c of cells) grid[c.dow][c.hour] = c;

  const maxStake = Math.max(1, ...cells.map((c) => c.stake));

  const totalBets = cells.reduce((s, c) => s + c.bets, 0);
  const totalStake = cells.reduce((s, c) => s + c.stake, 0);
  const peakCell = cells.reduce<HeatmapCell | null>(
    (best, c) => (!best || c.stake > best.stake ? c : best),
    null,
  );
  const dayTotals = new Array(7).fill(0) as number[];
  for (const c of cells) dayTotals[c.dow] += c.stake;
  const busiestDow = dayTotals.reduce(
    (maxIdx, v, i, arr) => (v > arr[maxIdx] ? i : maxIdx),
    0,
  );
  const busiestShare =
    totalStake > 0 ? (dayTotals[busiestDow] / totalStake) * 100 : 0;

  return (
    <div className="w-full h-full flex flex-col gap-2">
      <div className="flex-1 grid grid-cols-[auto_1fr] gap-x-2 grid-rows-[auto_repeat(7,minmax(0,1fr))] min-h-[168px]">
        <div className="col-start-2 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] text-[9px] text-muted-foreground">
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className="text-center"
              style={{
                gridColumn: `${h + 1} / span 1`,
                visibility: h % 3 === 0 ? "visible" : "hidden",
              }}
            >
              {h}
            </div>
          ))}
        </div>

        {grid.map((row, dow) => (
          <div key={dow} className="contents">
            <div className="text-[10px] text-muted-foreground flex items-center justify-end pr-1 min-w-[28px]">
              {DOW_LABELS[dow]}
            </div>
            <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px] h-full">
              {row.map((cell, hour) => {
                const intensity = cell ? cell.stake / maxStake : 0;
                return (
                  <div
                    key={hour}
                    className={cn(
                      "h-full min-h-[10px] rounded-[3px]",
                      cell ? "bg-cyan-400" : "bg-muted/50",
                      !cell && "border border-border/30",
                    )}
                    style={{
                      opacity: cell ? 0.15 + intensity * 0.85 : 1,
                    }}
                    title={
                      cell
                        ? `${DOW_LABELS[dow]} ${hour}:00 · ${cell.bets} bets · ${currency} ${cell.stake.toLocaleString()}`
                        : `${DOW_LABELS[dow]} ${hour}:00 · no activity`
                    }
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 pl-8 text-[10px] text-muted-foreground/70">
        <div className="flex items-center gap-1.5">
          <span>Low</span>
          <div className="flex gap-0.5">
            {[0.15, 0.35, 0.55, 0.75, 1].map((o) => (
              <div
                key={o}
                className="w-2.5 h-2.5 rounded-[3px] bg-cyan-400"
                style={{ opacity: o }}
              />
            ))}
          </div>
          <span>High</span>
        </div>
        <div className="text-[10px] font-mono tabular-nums tracking-tight">
          {totalBets === 0 ? (
            <span className="text-muted-foreground/40">No activity yet</span>
          ) : (
            <>
              <span className="text-muted-foreground">Peak</span>{" "}
              <span className="text-foreground font-medium">
                {peakCell
                  ? `${DOW_LABELS[peakCell.dow]} ${peakCell.hour}:00`
                  : "—"}
              </span>
              <span className="opacity-40 mx-1.5">·</span>
              <span className="text-muted-foreground">Busiest</span>{" "}
              <span className="text-foreground font-medium">
                {DOW_LABELS[busiestDow]} ({busiestShare.toFixed(0)}%)
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
