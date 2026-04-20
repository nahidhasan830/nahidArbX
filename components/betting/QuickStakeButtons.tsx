"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface QuickStakeButtonsProps {
  kellyStake: number;
  minStake: number | null;
  maxStake: number | null;
  balance: number;
  onSelectKelly: () => void;
  onSelectMin: () => void;
  onSelectHalf: () => void;
  onSelectMax: () => void;
  disabled?: boolean;
}

export function QuickStakeButtons({
  kellyStake,
  minStake,
  maxStake,
  balance,
  onSelectKelly,
  onSelectMin,
  onSelectHalf,
  onSelectMax,
  disabled = false,
}: QuickStakeButtonsProps) {
  const halfMax =
    maxStake != null ? Math.floor(maxStake / 2) : Math.floor(balance / 2);

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectKelly}
        disabled={disabled || kellyStake <= 0}
        className={cn(
          "h-6 px-2 text-[9px] font-bold uppercase tracking-wider transition-all",
          "border-border/40 hover:border-foreground/30 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        Kelly
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectMin}
        disabled={disabled || minStake == null}
        className={cn(
          "h-6 px-2 text-[9px] font-bold uppercase tracking-wider transition-all",
          "border-border/40 hover:border-foreground/30 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        Min
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectHalf}
        disabled={disabled || halfMax <= 0}
        className={cn(
          "h-6 px-2 text-[9px] font-bold uppercase tracking-wider transition-all",
          "border-border/40 hover:border-foreground/30 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        Half
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectMax}
        disabled={disabled || maxStake == null}
        className={cn(
          "h-6 px-2 text-[9px] font-bold uppercase tracking-wider transition-all",
          "border-border/40 hover:border-foreground/30 hover:bg-muted/50",
          disabled && "opacity-50 cursor-not-allowed",
        )}
      >
        Max
      </Button>
    </div>
  );
}
