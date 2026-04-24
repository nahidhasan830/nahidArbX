"use client";

/**
 * Single provider-odds cell for the value-bets spreadsheet.
 *
 * Renders one price with freshness + suspended/best-odds styling. Extracted
 * from ValueBetSpreadsheet so the row component can be split without
 * duplicating the price-cell styling logic.
 */

interface OddsCellProps {
  odds:
    | { value: number; timestamp: number; isBest: boolean; suspended?: boolean }
    | null
    | undefined;
  now: number;
  onClick?: () => void;
}

export function OddsCell({ odds, now, onClick }: OddsCellProps) {
  if (!odds) {
    return (
      <td className="text-center px-2 text-muted-foreground/40 font-mono text-[11px] tabular-nums">
        -
      </td>
    );
  }

  const isBest = odds.isBest;
  const isSuspended = odds.suspended;
  const clickable = Boolean(onClick) && !isSuspended;

  // Freshness indicator: green <1m, yellow <5m, red otherwise.
  const ageMinutes = (now - odds.timestamp) / 60000;
  const ageColor =
    ageMinutes < 1
      ? "bg-green-500"
      : ageMinutes < 5
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <td
      onClick={clickable ? onClick : undefined}
      title={clickable ? "Click to place a bet at this price" : undefined}
      className={`text-center px-2 font-mono text-[11px] tabular-nums relative ${
        isSuspended
          ? "text-muted-foreground/60"
          : isBest
            ? "font-bold text-green-400 bg-green-900/10"
            : "text-foreground"
      } ${clickable ? "cursor-pointer hover:bg-emerald-500/15 hover:ring-1 hover:ring-emerald-500/40" : ""}`}
    >
      <div className="flex flex-col items-center">
        <div className="flex items-center justify-center gap-1">
          <span className={isSuspended ? "opacity-60" : ""}>
            {odds.value.toFixed(2)}
          </span>
          {!isSuspended && isBest && (
            <span className="text-[9px] text-green-400">*</span>
          )}
        </div>
      </div>
      {isSuspended && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-yellow-900/40"
          title="Market suspended - not available for betting"
        >
          <span className="text-[8px] font-bold uppercase text-yellow-400 tracking-wider">
            Suspended
          </span>
        </div>
      )}
      {!isSuspended && (
        <div
          className={`absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${ageColor}`}
          title={`${Math.round(ageMinutes)} min ago`}
        />
      )}
    </td>
  );
}
