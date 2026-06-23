"use client";

import { memo } from "react";

interface SparklineProps {
  data: [number, number][];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  referenceData?: [number, number][];
  referenceColor?: string;
  className?: string;
}

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

  const allValues = refValues ? [...values, ...refValues] : values;
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = max - min || 1;

  const autoColor =
    values[values.length - 1] >= values[0]
      ? "hsl(142, 71%, 45%)"
      : "hsl(0, 84%, 60%)";
  const lineColor = color ?? autoColor;

  const padX = 2;
  const padY = 2;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const points = values
    .map((v, i) => {
      const x = padX + (i / (values.length - 1)) * plotW;
      const y = padY + plotH - ((v - min) / range) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const refPoints = refValues
    ? refValues
        .map((v, i) => {
          const x = padX + (i / (refValues.length - 1)) * plotW;
          const y = padY + plotH - ((v - min) / range) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : null;

  const fillPoints = fill
    ? `${padX},${padY + plotH} ${points} ${padX + plotW},${padY + plotH}`
    : "";

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
