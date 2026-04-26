"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  getProviderChartStroke,
  getProviderChartDot,
} from "@/lib/providers/registry";

export interface EdgeDecayBook {
  provider: string;
  providerDisplayName: string;
}

export interface EdgeDecayPoint {
  weekStart: string;
  values: Record<string, number | null>;
}

/**
 * Multi-line chart: CLV% per book per ISO week. Flat-line near zero means
 * the soft book has sharpened (edge decay); sustained positive CLV means
 * the edge still holds.
 */
export function EdgeDecayChart({
  books,
  points,
  height = 200,
}: {
  books: EdgeDecayBook[];
  points: EdgeDecayPoint[];
  height?: number;
}) {
  const { width, ticks, paths, yZero, bounds } = useMemo(
    () => layout(books, points, height),
    [books, points, height],
  );

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground border border-dashed border-border rounded-lg"
        style={{ height }}
      >
        Not enough data yet.
      </div>
    );
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
      >
        {/* gridlines */}
        {ticks.yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={36}
              x2={width - 4}
              y1={t.y}
              y2={t.y}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="2 3"
              strokeWidth={0.5}
            />
            <text
              x={32}
              y={t.y + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {t.value > 0 ? "+" : ""}
              {t.value.toFixed(1)}%
            </text>
          </g>
        ))}

        {yZero !== null && (
          <line
            x1={36}
            x2={width - 4}
            y1={yZero}
            y2={yZero}
            stroke="currentColor"
            className="text-border"
            strokeWidth={1}
          />
        )}

        {/* one path per book */}
        {paths.map((p) => (
          <path
            key={p.provider}
            d={p.d}
            fill="none"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            className={cn(
              "text-muted-foreground",
              getProviderChartStroke(p.provider),
            )}
            stroke="currentColor"
          />
        ))}

        {/* week labels */}
        {ticks.xTicks.map((t, i) => (
          <text
            key={i}
            x={t.x}
            y={height - 4}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px]"
          >
            {t.label}
          </text>
        ))}
      </svg>

      {/* legend */}
      <div className="flex items-center gap-3 pl-9 pt-1 text-[10px] text-muted-foreground flex-wrap">
        {books.map((book) => {
          const latest = bounds.latest[book.provider];
          return (
            <div key={book.provider} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-block w-2 h-2 rounded-full",
                  getProviderChartDot(book.provider),
                )}
              />
              <span className="text-foreground font-medium">
                {book.providerDisplayName}
              </span>
              {latest !== null && latest !== undefined && (
                <span
                  className={cn(
                    "tabular-nums",
                    latest > 0 && "text-emerald-500",
                    latest < 0 && "text-danger",
                  )}
                >
                  {latest > 0 ? "+" : ""}
                  {latest.toFixed(2)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function layout(
  books: EdgeDecayBook[],
  points: EdgeDecayPoint[],
  height: number,
) {
  const width = 600;
  const padL = 36;
  const padR = 4;
  const padT = 8;
  const padB = 18;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const allValues = points.flatMap((p) =>
    Object.values(p.values).filter((v): v is number => v !== null),
  );
  const minV = Math.min(0, ...allValues);
  const maxV = Math.max(0, ...allValues);
  const range = maxV - minV || 1;
  const pad = range * 0.1;

  const y = (v: number) =>
    padT + innerH - ((v - (minV - pad)) / (range + 2 * pad)) * innerH;
  const x = (i: number) =>
    points.length === 1
      ? padL + innerW / 2
      : padL + (i / (points.length - 1)) * innerW;

  const paths = books.map((book) => {
    let d = "";
    let pen = false;
    for (let i = 0; i < points.length; i++) {
      const v = points[i].values[book.provider];
      if (v === null || v === undefined) {
        pen = false;
        continue;
      }
      d += `${pen ? " L" : " M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return { provider: book.provider, d: d.trim() };
  });

  const yZero = minV < 0 && maxV > 0 ? y(0) : null;

  const yTicks = [0, 0.5, 1].map((f) => ({
    y: padT + f * innerH,
    value: minV - pad + (range + 2 * pad) * (1 - f),
  }));

  const xTickCount = Math.min(5, points.length);
  const xTicks = Array.from({ length: xTickCount }, (_, i) => {
    const idx = Math.round(((points.length - 1) * i) / (xTickCount - 1 || 1));
    return {
      x: x(idx),
      label: formatDate(points[idx].weekStart),
    };
  });

  // Latest known value per book (for legend)
  const latest: Record<string, number | null> = {};
  for (const book of books) {
    let v: number | null = null;
    for (let i = points.length - 1; i >= 0; i--) {
      const candidate = points[i].values[book.provider];
      if (candidate !== null && candidate !== undefined) {
        v = candidate;
        break;
      }
    }
    latest[book.provider] = v;
  }

  return {
    width,
    paths,
    yZero,
    ticks: { yTicks, xTicks },
    bounds: { latest },
  };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
