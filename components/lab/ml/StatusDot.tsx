"use client";

import { cn } from "@/lib/utils";
import type { RungStatus } from "@/lib/lab/ml/rungs";

const STATUS_DOT: Record<RungStatus, string> = {
  pass: "bg-emerald-400",
  warn: "bg-amber-400",
  fail: "bg-rose-400",
  pending: "bg-zinc-500",
  blocked: "bg-zinc-700",
};

const STATUS_RING: Record<RungStatus, string> = {
  pass: "ring-emerald-400/30",
  warn: "ring-amber-400/30",
  fail: "ring-rose-400/30",
  pending: "ring-zinc-500/20",
  blocked: "ring-transparent",
};

interface Props {
  status: RungStatus;
  className?: string;
  size?: "sm" | "md";
}

/**
 * Single status indicator dot with a subtle ring. Used in rung rows
 * and the activity feed.
 */
export function StatusDot({ status, className, size = "md" }: Props) {
  const dim = size === "sm" ? "size-1.5" : "size-2";
  return (
    <span
      className={cn(
        "inline-block rounded-full ring-2",
        dim,
        STATUS_DOT[status],
        STATUS_RING[status],
        className,
      )}
      aria-label={`status: ${status}`}
    />
  );
}
