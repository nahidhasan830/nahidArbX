"use client";

/**
 * Small visual primitives shared across EntityInspector panels:
 * status pills, KPI cards, sparklines, donut, and the relative-time
 * label. Kept dependency-free (just Tailwind + SVG) so they don't
 * inflate the bundle.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  OUTCOME_TONES,
  RUN_STATUS_TONES,
  STATUS_TONES,
  type EntityName,
  type ResolverRunRow,
} from "./types";

// ── Pills ────────────────────────────────────────────────────────────────

export function StatusPill({
  status,
  className,
}: {
  status: EntityName["status"];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold border",
        STATUS_TONES[status],
        className,
      )}
    >
      {status}
    </span>
  );
}

export function OutcomePill({ outcome }: { outcome: string }) {
  const tone = OUTCOME_TONES[outcome] ?? "bg-zinc-800/40 text-zinc-400";
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium",
        tone,
      )}
    >
      {outcome}
    </span>
  );
}

export function RunStatusPill({
  status,
}: {
  status: ResolverRunRow["status"];
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase font-semibold border",
        RUN_STATUS_TONES[status],
      )}
    >
      {status}
    </span>
  );
}

// ── Time helpers ─────────────────────────────────────────────────────────

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

export function durationLabel(ms: number | null | undefined): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s ? ` ${s}s` : ""}`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m ? ` ${m}m` : ""}`;
}

// ── KPI Card ─────────────────────────────────────────────────────────────

export function KpiCard({
  label,
  value,
  delta,
  hint,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  hint?: string;
  tone?: "default" | "warn" | "good" | "bad";
}) {
  const valueTone =
    tone === "warn"
      ? "text-amber-300"
      : tone === "good"
        ? "text-emerald-300"
        : tone === "bad"
          ? "text-rose-300"
          : "text-zinc-100";
  return (
    <div className="rounded border border-zinc-800/60 bg-zinc-900/40 p-3 flex flex-col gap-0.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={cn("text-lg font-semibold tabular-nums", valueTone)}>
        {value}
      </div>
      {(delta || hint) && (
        <div className="text-[10px] text-zinc-500">
          {delta} {hint && <span className="ml-1 opacity-70">{hint}</span>}
        </div>
      )}
    </div>
  );
}

// ── Sparkline ────────────────────────────────────────────────────────────

export function Sparkline({
  values,
  width = 220,
  height = 36,
  stroke = "currentColor",
  fill,
}: {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}) {
  if (values.length === 0) {
    return (
      <div
        className="text-[10px] text-zinc-600 flex items-center justify-center"
        style={{ width, height }}
      >
        no data
      </div>
    );
  }
  const max = Math.max(1, ...values);
  const dx = width / Math.max(values.length - 1, 1);
  const points = values
    .map((v, i) => {
      const x = i * dx;
      const y = height - (v / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const fillPoints = `0,${height} ${points} ${width},${height}`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      {fill && <polygon points={fillPoints} fill={fill} opacity={0.3} />}
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

// ── Bar histogram (for classifier-score distribution) ────────────────────

export function BarChart({
  values,
  labels,
  height = 56,
  width = 220,
  barClassName = "fill-violet-500/70",
}: {
  values: number[];
  labels?: string[];
  height?: number;
  width?: number;
  barClassName?: string;
}) {
  if (values.length === 0) {
    return (
      <div
        className="text-[10px] text-zinc-600 flex items-center justify-center"
        style={{ width, height }}
      >
        no data
      </div>
    );
  }
  const max = Math.max(1, ...values);
  const gap = 1;
  const bw = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
    >
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * (height - 12));
        const x = i * (bw + gap);
        const y = height - h;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={bw}
              height={h}
              className={barClassName}
              rx={1}
            />
            {labels?.[i] && (
              <text
                x={x + bw / 2}
                y={height - 1}
                textAnchor="middle"
                className="fill-zinc-600 text-[7px]"
              >
                {labels[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Field label wrapper ──────────────────────────────────────────────────

export function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-0.5">
        {label}
      </div>
      {children}
    </label>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────

export function EmptyHint({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-zinc-500 text-xs gap-1">
      <div className="text-sm font-medium text-zinc-400">{title}</div>
      {description && <div className="opacity-70">{description}</div>}
    </div>
  );
}
