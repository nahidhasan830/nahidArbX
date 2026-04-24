"use client";

import {
  CartesianGrid,
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
  x: number; // max drawdown
  y: number; // OOS ROI (mean)
  z: number; // sample size (point area)
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

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          type="number"
          dataKey="x"
          name="Max drawdown"
          tick={{ fontSize: 10 }}
          label={{
            value: "Max drawdown (lower is better)",
            position: "insideBottom",
            offset: -10,
            style: { fontSize: 10, fill: "currentColor" },
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="OOS ROI %"
          tick={{ fontSize: 10 }}
          label={{
            value: "OOS ROI %",
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 10, fill: "currentColor" },
          }}
        />
        <ZAxis dataKey="z" range={[20, 240]} name="Sample size" />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0]?.payload as Point;
            return (
              <div className="rounded-md border border-border bg-background p-2 text-[10px] space-y-0.5 shadow-md">
                <div className="font-medium">Trial #{p.trialIndex}</div>
                <div>OOS ROI: {p.y.toFixed(2)}%</div>
                <div>Max DD: {p.x.toFixed(2)}</div>
                <div>Sample: {p.z} bets</div>
                {p.dsr !== null && <div>DSR: {p.dsr.toFixed(3)}</div>}
                {p.composite !== null && (
                  <div>Composite: {p.composite.toFixed(3)}</div>
                )}
                {p.pareto && (
                  <div className="text-emerald-500 font-medium">
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
          fill="hsl(var(--muted-foreground))"
          fillOpacity={0.4}
        />
        <Scatter
          name="Pareto"
          data={onFrontier}
          fill="hsl(var(--primary))"
          fillOpacity={0.95}
        />
      </ScatterChart>
    </ResponsiveContainer>
  );
}
