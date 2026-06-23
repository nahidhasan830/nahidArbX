"use client";

import { cn } from "@/lib/utils";

export interface ProgressItem {
  id: string;
  label: string;
  current: number;
  total: number;
  sublabel?: string | null;
  tooltip?: string;
  unit?: string;
}

export interface MultiProgressListProps {
  items: ProgressItem[];
  emptyState?: React.ReactNode;
  heading?: string;
  headingRight?: React.ReactNode;
  className?: string;
}

export function MultiProgressList({
  items,
  emptyState,
  heading,
  headingRight,
  className,
}: MultiProgressListProps) {
  if (items.length === 0 && emptyState) {
    return (
      <div className={cn("space-y-1.5", className)}>
        {heading && <Header heading={heading} right={headingRight} />}
        {emptyState}
      </div>
    );
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {heading && <Header heading={heading} right={headingRight} />}
      <ul className="space-y-1.5">
        {items.map((item) => (
          <ProgressRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function Header({
  heading,
  right,
}: {
  heading: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {heading}
      </div>
      {right && <div className="text-[10px]">{right}</div>}
    </div>
  );
}

function ProgressRow({ item }: { item: ProgressItem }) {
  const total = Math.max(item.total, 0);
  const current = Math.max(Math.min(item.current, total), 0);
  const pct = total > 0 ? current / total : 0;
  const done = pct >= 1;

  const barColor = done
    ? "bg-emerald-500"
    : pct >= 0.8
      ? "bg-emerald-500/80"
      : pct >= 0.33
        ? "bg-amber-500"
        : "bg-danger";

  const unit = item.unit ? ` ${item.unit}` : "";
  const fmt = (n: number) =>
    n >= 10_000
      ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
      : n.toFixed(2);

  return (
    <li className="rounded border border-border/60 bg-background/40 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium truncate">{item.label}</div>
          {item.sublabel && (
            <div className="text-[10px] text-muted-foreground truncate">
              {item.sublabel}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs font-semibold tabular-nums">
            {fmt(current)}
            <span className="text-muted-foreground"> / {fmt(total)}</span>
            <span className="text-muted-foreground">{unit}</span>
          </div>
          <div
            className={cn(
              "text-[10px] tabular-nums",
              done ? "text-emerald-500" : "text-muted-foreground",
            )}
          >
            {(pct * 100).toFixed(1)}%
          </div>
        </div>
      </div>
      <div
        className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden"
        title={item.tooltip}
      >
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${Math.min(100, pct * 100)}%` }}
        />
      </div>
    </li>
  );
}
