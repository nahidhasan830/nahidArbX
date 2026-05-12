"use client";

import { memo } from "react";

interface SparklineProps {
  /** Array of [timestamp, value] tuples. */
  data: [number, number][];
  /** SVG width in px. */
  width?: number;
  /** SVG height in px. */
  height?: number;
  /** Line color override. When omitted, auto-selects green/red based on trend. */
  color?: string;
  /** Show a subtle gradient fill under the line. */
  fill?: boolean;
  /** Optional reference line data (e.g. sharp provider baseline). Rendered as a faded dashed line. */
  referenceData?: [number, number][];
  /** Reference line color. Defaults to a faded slate. */
  referenceColor?: string;
  /** Additional CSS classes. */
  className?: string;
}

/**
 * Zero-dependency inline SVG sparkline.
 *
 * Renders a compact price-movement chart suitable for embedding in table cells.
 * Uses `<polyline>` for the line and an optional `<linearGradient>` fill.
 * Optionally overlays a reference line (e.g. sharp provider) as a faded dashed trace.
 * Wrapped in `React.memo` so virtualized tables only re-render on data change.
 */
function SparklineInner({
  data,
  width = 80,
  height = 20,
  color,
  fill = true,
  referenceData,
  referenceColor = "rgba(148, 163, 184, 0.4)",
  className,
}: SparklineProps) {
  if (data.length < 2) return null;

  const values = data.map((d) => d[1]);
  const refValues =
    referenceData && referenceData.length >= 2
      ? referenceData.map((d) => d[1])
      : null;

  // Compute global min/max across both series so they share the same Y-axis
  const allValues = refValues ? [...values, ...refValues] : values;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1; // Avoid division by zero for flat lines

  // Auto-color: green if trending up, red if down
  const autoColor =
    values[values.length - 1] >= values[0]
      ? "hsl(142, 71%, 45%)" // green
      : "hsl(0, 84%, 60%)"; // red
  const lineColor = color ?? autoColor;

  // Horizontal padding to avoid clipping the stroke at edges
  const padX = 2;
  const padY = 2;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  // Map data to SVG coordinates
  const points = values
    .map((v, i) => {
      const x = padX + (i / (values.length - 1)) * plotW;
      const y = padY + plotH - ((v - min) / range) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Reference line points (mapped to same scale)
  const refPoints = refValues
    ? refValues
        .map((v, i) => {
          const x = padX + (i / (refValues.length - 1)) * plotW;
          const y = padY + plotH - ((v - min) / range) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : null;

  // Closed polygon for gradient fill (line + bottom edge)
  const fillPoints = fill
    ? `${padX},${padY + plotH} ${points} ${padX + plotW},${padY + plotH}`
    : "";

  // Unique gradient ID (safe for SSR — no crypto needed for inline SVGs)
  const gradientId = `spark-${width}-${height}-${data.length}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      {fill && (
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.25} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
      )}
      {fill && fillPoints && (
        <polygon
          points={fillPoints}
          fill={`url(#${gradientId})`}
          stroke="none"
        />
      )}
      {/* Reference line — dashed, faded, drawn behind the main line */}
      {refPoints && (
        <polyline
          points={refPoints}
          fill="none"
          stroke={referenceColor}
          strokeWidth={1}
          strokeDasharray="3 2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot — highlights the current price */}
      <circle
        cx={padX + plotW}
        cy={padY + plotH - ((values[values.length - 1] - min) / range) * plotH}
        r={1.5}
        fill={lineColor}
      />
    </svg>
  );
}

export const Sparkline = memo(SparklineInner);
