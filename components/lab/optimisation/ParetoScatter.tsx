"use client";

import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { OptimizationTrialRow } from "@/lib/optimizer/repository";

interface Point {
  x: number;
  y: number;
  z: number;
  pareto: boolean;
  trialIndex: number;
  composite: number | null;
  dsr: number | null;
}

export function ParetoScatter({ trials }: { trials: OptimizationTrialRow[] }) {
  const points: Point[] = trials
    .filter((t) => t.maxDrawdown !== null && t.oosRoiMean !== null)
    .map((t) => ({
      x: Number(t.maxDrawdown),
      y: Number(t.oosRoiMean),
      z: Math.max(t.sampleSize ?? 1, 1),
      pareto: t.onPareto,
      trialIndex: t.trialIndex,
      composite: t.compositeScore !== null ? Number(t.compositeScore) : null,
      dsr: t.deflatedSharpe !== null ? Number(t.deflatedSharpe) : null,
    }));

  const dominated = points.filter((p) => !p.pareto);
  const onFrontier = points.filter((p) => p.pareto);

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-xs text-muted-foreground">
        No completed trials yet
      </div>
    );
  }

  const axisColor = "var(--muted-foreground)";
  const gridColor = "var(--border)";
  const paretoColor = "var(--positive)";
  const dominatedColor = "var(--muted-foreground)";
  const cardColor = "var(--card)";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-full ring-1"
            style={{
              background: paretoColor,
              boxShadow: `0 0 0 1.5px ${cardColor}`,
            }}
          />
          Pareto frontier ({onFrontier.length})
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-full opacity-60"
            style={{ background: dominatedColor }}
          />
          Dominated ({dominated.length})
        </span>
        <span className="text-[10px] text-muted-foreground/70">
          · dot size = sample size
        </span>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={gridColor}
            strokeOpacity={0.6}
          />
          <XAxis
            type="number"
            dataKey="x"
            name="Max drawdown"
            stroke={axisColor}
            tick={{ fontSize: 10, fill: axisColor }}
            tickLine={{ stroke: axisColor, strokeOpacity: 0.4 }}
            axisLine={{ stroke: axisColor, strokeOpacity: 0.4 }}
            label={{
              value: "Max drawdown (lower is better)",
              position: "insideBottom",
              offset: -10,
              style: { fontSize: 10, fill: axisColor },
            }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="OOS ROI %"
            stroke={axisColor}
            tick={{ fontSize: 10, fill: axisColor }}
            tickLine={{ stroke: axisColor, strokeOpacity: 0.4 }}
            axisLine={{ stroke: axisColor, strokeOpacity: 0.4 }}
            label={{
              value: "OOS ROI %",
              angle: -90,
              position: "insideLeft",
              style: { fontSize: 10, fill: axisColor },
            }}
          />
          <ZAxis dataKey="z" range={[40, 280]} name="Sample size" />
          <ReferenceLine
            y={0}
            stroke={axisColor}
            strokeDasharray="4 4"
            strokeOpacity={0.5}
            label={{
              value: "break-even",
              position: "insideTopRight",
              fontSize: 9,
              fill: axisColor,
            }}
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3", stroke: axisColor }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0]?.payload as Point;
              return (
                <div className="rounded-md border border-border bg-popover p-2 text-[10px] space-y-0.5 shadow-lg">
                  <div className="font-medium text-foreground">
                    Trial #{p.trialIndex}
                  </div>
                  <div className="text-muted-foreground">
                    OOS ROI:{" "}
                    <span className="text-foreground tabular-nums">
                      {p.y.toFixed(2)}%
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    Max DD:{" "}
                    <span className="text-foreground tabular-nums">
                      {p.x.toFixed(2)}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    Sample:{" "}
                    <span className="text-foreground tabular-nums">
                      {p.z} bets
                    </span>
                  </div>
                  {p.dsr !== null && (
                    <div className="text-muted-foreground">
                      DSR:{" "}
                      <span className="text-foreground tabular-nums">
                        {p.dsr.toFixed(3)}
                      </span>
                    </div>
                  )}
                  {p.composite !== null && (
                    <div className="text-muted-foreground">
                      Composite:{" "}
                      <span className="text-foreground tabular-nums">
                        {p.composite.toFixed(3)}
                      </span>
                    </div>
                  )}
                  {p.pareto && (
                    <div
                      className="font-medium pt-1"
                      style={{ color: paretoColor }}
                    >
                      On Pareto frontier
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Scatter
            name="Dominated"
            data={dominated}
            fill={dominatedColor}
            fillOpacity={0.35}
            stroke={dominatedColor}
            strokeOpacity={0.7}
            strokeWidth={0.75}
          />
          <Scatter
            name="Pareto"
            data={onFrontier}
            fill={paretoColor}
            fillOpacity={0.9}
            stroke={cardColor}
            strokeWidth={1.5}
          />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
