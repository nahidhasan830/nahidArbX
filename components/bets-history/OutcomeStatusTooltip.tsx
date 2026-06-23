
import { cn } from "@/lib/utils";
import { prettySettledBy } from "@/lib/bets-history/resettle";
import type { BetMatchScore, ValueBetRow } from "@/lib/bets-history/types";

const STATUS_BADGE: Record<string, string> = {
  FT: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  AET: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  PEN: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  ABD: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  POSTPONED: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const STATUS_LABEL: Record<string, string> = {
  FT: "Full Time",
  AET: "After Extra Time",
  PEN: "Penalties",
  ABD: "Abandoned",
  POSTPONED: "Postponed",
};

const isCornersMarket = (m: string): boolean =>
  m === "CORNERS" ||
  m === "CORNERS_HANDICAP" ||
  m === "CORNERS_EUROPEAN_HANDICAP" ||
  m === "HOME_CORNERS_TOTAL" ||
  m === "AWAY_CORNERS_TOTAL";

const isBookingsMarket = (m: string): boolean =>
  m === "BOOKINGS" || m === "BOOKINGS_HANDICAP";

interface ScoreRowProps {
  label: string;
  home: number | string;
  away: number | string;
  emphasized?: boolean;
}

function ScoreRow({ label, home, away, emphasized }: ScoreRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "tabular-nums font-medium",
          emphasized
            ? "text-sm text-foreground"
            : "text-[12px] text-foreground/85",
        )}
      >
        <span>{home}</span>
        <span className="mx-1.5 text-muted-foreground/50">–</span>
        <span>{away}</span>
      </span>
    </div>
  );
}

export interface OutcomeStatusTooltipContentProps {
  row: Pick<
    ValueBetRow,
    "homeTeam" | "awayTeam" | "marketType" | "settledBySource"
  > & {
    matchScore?: BetMatchScore | null;
  };
  outcomeLabel: string;
  footerHint?: string;
}

export function OutcomeStatusTooltipContent({
  row,
  outcomeLabel,
  footerHint = "Click pill to edit outcome",
}: OutcomeStatusTooltipContentProps) {
  const score = row.matchScore;

  if (!score) {
    return (
      <div className="flex flex-col gap-1.5 py-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-foreground">
            {outcomeLabel}
          </span>
          <span className="text-[10px] text-muted-foreground">
            · score not fetched yet
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/80">
          {footerHint}
        </span>
      </div>
    );
  }

  const status = (score.status ?? "FT").toUpperCase();
  const badgeCls = STATUS_BADGE[status] ?? STATUS_BADGE.FT;
  const statusFullLabel = STATUS_LABEL[status] ?? status;

  const isVoidStatus = status === "ABD" || status === "POSTPONED";

  const hasHt = score.htHome != null && score.htAway != null;
  const hasEt = score.etHome != null && score.etAway != null;
  const hasPen = score.penHome != null && score.penAway != null;

  const showCorners =
    isCornersMarket(row.marketType) &&
    score.cornersHome != null &&
    score.cornersAway != null;
  const showBookings =
    isBookingsMarket(row.marketType) &&
    score.bookingsHome != null &&
    score.bookingsAway != null;

  const sourceLabel = prettySettledBy(score.source);
  const confidencePct = Math.round(score.confidence * 100);

  return (
    <div className="flex w-[260px] flex-col gap-2 py-0.5">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            badgeCls,
          )}
          title={statusFullLabel}
        >
          {status}
        </span>
        <span className="text-[11px] font-medium text-foreground">
          {outcomeLabel}
        </span>
      </div>

      <div className="flex items-baseline justify-between gap-3 border-b border-border/40 pb-1.5 text-[11px]">
        <span className="truncate text-foreground/85" title={row.homeTeam}>
          {row.homeTeam}
        </span>
        <span
          className="truncate text-right text-foreground/85"
          title={row.awayTeam}
        >
          {row.awayTeam}
        </span>
      </div>

      {isVoidStatus ? (
        <div className="text-[11px] text-muted-foreground">
          Match {statusFullLabel.toLowerCase()} — stake voided.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {hasHt && (
            <ScoreRow label="HT" home={score.htHome!} away={score.htAway!} />
          )}
          <ScoreRow
            label="FT"
            home={score.ftHome}
            away={score.ftAway}
            emphasized
          />
          {hasEt && (
            <ScoreRow label="ET" home={score.etHome!} away={score.etAway!} />
          )}
          {hasPen && (
            <ScoreRow
              label="Pens"
              home={score.penHome!}
              away={score.penAway!}
            />
          )}
          {showCorners && (
            <ScoreRow
              label="Corners"
              home={score.cornersHome!}
              away={score.cornersAway!}
            />
          )}
          {showBookings && (
            <ScoreRow
              label="Booking pts"
              home={score.bookingsHome!}
              away={score.bookingsAway!}
            />
          )}
        </div>
      )}

      <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5">
        <div className="flex items-baseline justify-between gap-2 text-[10px]">
          <span className="text-muted-foreground">Source</span>
          <span className="font-medium text-foreground/85">
            {sourceLabel}
            <span className="ml-1 text-muted-foreground/70 tabular-nums">
              · {confidencePct}%
            </span>
          </span>
        </div>
        <span className="text-[10px] italic text-muted-foreground/70">
          {footerHint}
        </span>
      </div>
    </div>
  );
}
