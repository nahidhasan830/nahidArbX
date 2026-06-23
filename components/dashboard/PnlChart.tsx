"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMemo } from "react";
import { format, parseISO } from "date-fns";

export interface PnlPoint {
  date: string;
  actual: number;
  expected: number;
}

export function PnlChart({
  data,
  currency = "BDT",
  height = 240,
}: {
  data: PnlPoint[];
  currency?: string;
  height?: number | string;
}) {
  const formatted = useMemo(
    () =>
      data.map((p) => ({
        ...p,
        label: format(parseISO(p.date), "MMM d"),
      })),
    [data],
  );

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground border border-dashed border-border rounded-lg"
        style={{ height }}
      >
        No P&L data yet.
      </div>
    );
  }

  const money = (n: number) =>
    `${currency} ${n.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;

  return (
    <div style={{ height, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={formatted}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        >
          <defs>
            <linearGradient id="pnl-actual" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="rgb(34 211 238)" stopOpacity={0.3} />
              <stop offset="95%" stopColor="rgb(34 211 238)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="pnl-expected" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor="rgb(148 163 184)"
                stopOpacity={0.1}
              />
              <stop offset="95%" stopColor="rgb(148 163 184)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            opacity={0.08}
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fill: "currentColor", fontSize: 10, opacity: 0.6 }}
            tickLine={false}
            axisLine={{ stroke: "currentColor", opacity: 0.15 }}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: "currentColor", fontSize: 10, opacity: 0.6 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) =>
              Math.abs(v) >= 1000
                ? `${(v / 1000).toFixed(1)}k`
                : String(Math.round(v))
            }
            width={44}
          />
          <ReferenceLine
            y={0}
            stroke="currentColor"
            strokeDasharray="2 4"
            opacity={0.35}
          />
          <Tooltip
            cursor={{
              stroke: "currentColor",
              strokeOpacity: 0.15,
              strokeDasharray: "3 3",
            }}
            contentStyle={{
              background: "oklch(0.15 0.008 250)",
              border: "1px solid oklch(1 0 0 / 10%)",
              borderRadius: 8,
              fontSize: 11,
              padding: "8px 10px",
              fontFamily: "var(--font-jetbrains), monospace",
              boxShadow: "0 4px 20px oklch(0 0 0 / 30%)",
            }}
            labelStyle={{ color: "oklch(0.60 0.015 250)", fontSize: 10 }}
            formatter={(value, name) => [
              money(Number(value)),
              name === "actual" ? "Actual" : "Expected (EV)",
            ]}
          />
          <Area
            type="monotone"
            dataKey="expected"
            stroke="rgb(148 163 184)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            fill="url(#pnl-expected)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="actual"
            stroke="rgb(34 211 238)"
            strokeWidth={2}
            fill="url(#pnl-actual)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
