/**
 * TriggerBadge — shared pill badge for filter dropdown triggers.
 * Matches the BetsHistoryToolbar pattern exactly.
 * Active state: primary color accent. Inactive: secondary muted.
 */

import { cn } from "@/lib/utils";

export function TriggerBadge({
  children,
  active,
}: {
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full h-4 min-w-[18px] px-1.5 text-[10px] font-medium tabular-nums",
        active
          ? "bg-primary/20 text-primary dark:bg-primary/30"
          : "bg-secondary text-secondary-foreground dark:bg-white/10",
      )}
    >
      {children}
    </span>
  );
}
