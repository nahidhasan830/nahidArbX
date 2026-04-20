"use client";

import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  textColor?: string;
}

export function StatCard({ label, value, sub, textColor }: StatCardProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <div className="flex items-center gap-1">
        <span
          className={cn(
            "text-[12px] font-bold tabular-nums",
            textColor || "text-foreground",
          )}
        >
          {value}
        </span>
        {sub && (
          <span className="text-[9px] font-bold text-muted-foreground uppercase tracking-widest pb-0.5">
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}
