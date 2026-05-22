"use client";

/**
 * One row of the value-bets spreadsheet.
 *
 * Extracted from ValueBetSpreadsheet. The row carries cross-row layout
 * decisions via the `isFirst*` / `isLast*` flags on the incoming row — the
 * parent recomputes these after filtering so family borders and event headers
 * still render correctly. This component trusts those flags and just renders.
 *
 * Colocated helpers (`formatEventTime`, `countValueProviders`) live here
 * because the row is their only caller.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Badge } from "@/components/ui/badge";
import { Copy, X } from "lucide-react";
import { Feature } from "@/components/auth/AuthProvider";
import { getProviderColorClasses as getProviderBadgeClasses } from "@/lib/providers/registry";
import { OddsCell } from "./OddsCell";
import { format, isToday, isTomorrow, isValid, parseISO } from "date-fns";

import {
  getProviderShortName,
  getSharpProviders,
  getSoftProviders,
  type ProviderKey,
} from "@/lib/providers/registry";
import { CONFIGURED_BETTING_PROVIDER_IDS } from "@/lib/betting/configured-ids";
import type { SpreadsheetRow } from "@/lib/formatting/spreadsheet";
import type { LiveMatchInfo, ValueBetDetails } from "./ValueBetDetailsModal";

/**
 * Format a kickoff time for the standalone KO column.
 * Shows "Started Nm ago" for already-live events; otherwise short date+time.
 */
function formatEventTime(startTime: string, nowMs: number): string {
  const date = parseISO(startTime);
  if (!isValid(date)) return startTime;
  const dateMs = date.getTime();

  if (dateMs <= nowMs) {
    const diffMs = nowMs - dateMs;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    return `${diffHours}h ${diffMins % 60}m ago`;
  }

  const time = format(date, "HH:mm");
  if (isToday(date)) return `Today ${time}`;
  if (isTomorrow(date)) return `Tomorrow ${time}`;
  return format(date, "d MMM HH:mm");
}

/**
 * Count how many soft providers show a positive-EV opportunity at the given
 * true probability. Used as a "N providers" hint next to the EV column.
 */
function countValueProviders(
  odds: Partial<
    Record<
      ProviderKey,
      { value: number; timestamp: number; suspended?: boolean }
    >
  >,
  trueProb: number | null,
): number {
  if (!trueProb || trueProb <= 0) return 0;
  const softProviders = getSoftProviders();
  let count = 0;
  for (const provider of softProviders) {
    const od = odds[provider];
    if (!od || od.suspended) continue;
    if (od.value * trueProb - 1 > 0) count++;
  }
  return count;
}

interface LiveScoreData {
  home: number;
  away: number;
  minute: number;
  period: string;
  homeRedCards: number;
  awayRedCards: number;
  primarySource?: "pinnacle" | "betconstruct";
  confidence?: "high" | "medium" | "low" | "stale";
  hasDiscrepancy?: boolean;
  alternativeScore?: {
    source: "pinnacle" | "betconstruct";
    home: number;
    away: number;
  };
}

export interface SpreadsheetRowProps {
  row: SpreadsheetRow;
  visibleProviders: ProviderKey[];
  isLastInFamily: boolean;
  nowMs: number;

  eventProviders: ProviderKey[];
  providerEventIds: Record<string, string>;
  copyingRawData: string | null;
  onSelectValueBet: (data: {
    eventLabel: string;
    competition: string;
    startTime: string;
    marketLabel: string;
    outcomeLabel: string;
    atomId: string;
    familyId: string;
    marketType: string;
    details: ValueBetDetails;
    eventId: string;
    providerEventIds: Record<string, string>;
    atomOdds: SpreadsheetRow["odds"];
    liveScore?: LiveMatchInfo;
  }) => void;
  onCopyRawData: (
    eventId: string,
    provider: ProviderKey,
    providerEventId?: string,
  ) => void;
  onHide: (eventId: string, familyId: string) => void;
  /** Opens the movement detail modal for this provider's odds. */
  onMovementClick?: (
    oddsRow: SpreadsheetRow["odds"],
    context: {
      eventLabel: string;
      marketLabel: string;
      valueBetDetails?: SpreadsheetRow["valueBetDetails"];
      startTime?: string;
      marketType?: string;
      line?: number;
      providerCount?: number;
    },
  ) => void;
  liveScore?: LiveScoreData;
  /** Event-level suspension (all markets blocked) */
  suspended?: boolean;
}

export function SpreadsheetRow({
  row,
  visibleProviders,
  isLastInFamily,
  nowMs,

  eventProviders,
  providerEventIds,
  copyingRawData,
  onSelectValueBet,
  onCopyRawData,
  onHide,
  onMovementClick,
  liveScore,
  suspended,
}: SpreadsheetRowProps) {
  // All columns always visible now — column filtering was removed in the
  // toolbar cleanup.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isVisible = (col: string) => true;

  const isLive = new Date(row.startTime).getTime() <= nowMs;

  const rowClasses = [
    "group",
    "h-[30px] text-[11px] align-middle",
    "hover:bg-muted/40 transition-colors",
    row.hasValue && "bg-cyan-900/5",
    row.isFirstFamilyInEvent && "border-t-2 border-border",
    row.isFirstAtomInFamily &&
      !row.isFirstFamilyInEvent &&
      "border-t border-border/50",
    isLastInFamily && "border-b border-border/50",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr className={rowClasses}>
      {isVisible("event") && (
        <td className="px-3 text-foreground sticky left-0 bg-card overflow-hidden">
          {row.isFirstFamilyInEvent && row.isFirstAtomInFamily ? (
            <div className="flex items-center gap-1.5 min-w-0">
              {suspended && (
                <Badge
                  variant="outline"
                  className="px-1 py-0 text-[9px] font-bold uppercase h-4 shrink-0 bg-yellow-900/40 text-yellow-400 border-yellow-600/50"
                >
                  Blocked
                </Badge>
              )}
              {isLive && (
                <Badge
                  variant="destructive"
                  className="px-1 py-0 text-[9px] font-bold uppercase h-4 shrink-0"
                >
                  Live
                </Badge>
              )}
              <span className="font-medium truncate" title={row.eventLabel}>
                {row.eventLabel}
              </span>
              {row.competition && (
                <span
                  className="text-muted-foreground/70 text-[10px] truncate shrink min-w-0"
                  title={row.competition}
                >
                  · {row.competition}
                </span>
              )}
              {isLive && liveScore && (
                <>
                  <span className="text-muted-foreground/50 shrink-0">|</span>
                  {liveScore.hasDiscrepancy && (
                    <span
                      className="text-yellow-500 shrink-0"
                      title={`Score mismatch! Pinnacle: ${liveScore.alternativeScore?.source === "pinnacle" ? `${liveScore.alternativeScore.home}-${liveScore.alternativeScore.away}` : `${liveScore.home}-${liveScore.away}`}, BC: ${liveScore.alternativeScore?.source === "betconstruct" ? `${liveScore.alternativeScore.home}-${liveScore.alternativeScore.away}` : `${liveScore.home}-${liveScore.away}`}`}
                    >
                      !
                    </span>
                  )}
                  <span className="font-mono font-bold text-xs text-yellow-400 shrink-0">
                    {liveScore.home}-{liveScore.away}
                  </span>
                  <span className="text-muted-foreground text-[10px] shrink-0">
                    {liveScore.minute}&apos;
                  </span>
                  {liveScore.primarySource && (
                    <span
                      className={`text-[8px] px-0.5 rounded shrink-0 ${
                        liveScore.primarySource === "pinnacle"
                          ? "bg-blue-900/40 text-blue-300"
                          : "bg-purple-900/40 text-purple-300"
                      } ${
                        liveScore.confidence === "stale"
                          ? "opacity-50"
                          : liveScore.confidence === "low"
                            ? "ring-1 ring-yellow-500"
                            : ""
                      }`}
                      title={`Source: ${liveScore.primarySource === "pinnacle" ? "Pinnacle WS" : "BetConstruct"} (${liveScore.confidence || "medium"} confidence)`}
                    >
                      {liveScore.primarySource === "pinnacle" ? "P" : "BC"}
                    </span>
                  )}
                  {(liveScore.homeRedCards > 0 ||
                    liveScore.awayRedCards > 0) && (
                    <span
                      className="text-red-500 font-bold text-[10px] shrink-0"
                      title="Red cards"
                    >
                      {liveScore.homeRedCards + liveScore.awayRedCards}R
                    </span>
                  )}
                </>
              )}
            </div>
          ) : null}
        </td>
      )}

      {isVisible("ko") && (
        <td className="px-2 text-center text-muted-foreground text-[10px] tabular-nums">
          {row.isFirstFamilyInEvent && row.isFirstAtomInFamily
            ? formatEventTime(row.startTime, nowMs)
            : null}
        </td>
      )}

      {isVisible("market") && (
        <td className="px-2 text-center text-foreground overflow-hidden">
          {row.isFirstAtomInFamily ? (
            <span className="truncate block" title={row.marketLabel}>
              {row.marketLabel}
            </span>
          ) : null}
        </td>
      )}

      {isVisible("outcome") && (
        <td className="px-2 text-center text-foreground">{row.outcomeLabel}</td>
      )}

      {/* EV % — clickable only when hasValue (valid +EV). Non-value rows show
          the EV number for context but don't open the placement modal. */}
      {isVisible("ev") && (
        <td
          className={`text-center px-2 font-mono text-[11px] tabular-nums bg-cyan-50/30 dark:bg-cyan-900/10 ${
            row.hasValue
              ? "cursor-pointer hover:bg-cyan-100/50 dark:hover:bg-cyan-900/30"
              : ""
          }`}
          onClick={
            row.hasValue && row.valueBetDetails
              ? () => {
                  onSelectValueBet({
                    eventLabel: row.eventLabel,
                    competition: row.competition,
                    startTime: row.startTime,
                    marketLabel: row.marketLabel,
                    outcomeLabel: row.outcomeLabel,
                    atomId: row.atomId,
                    familyId: row.familyId,
                    marketType: row.marketType,
                    details: row.valueBetDetails!,
                    eventId: row.eventId,
                    providerEventIds,
                    atomOdds: row.odds,
                    liveScore,
                  });
                }
              : undefined
          }
          title={row.hasValue ? "Click to open placement details" : undefined}
        >
          {row.evPct !== null ? (
            <div className="flex items-center justify-center gap-1 whitespace-nowrap">
              <span
                className={
                  row.hasValue
                    ? "font-bold text-cyan-600 dark:text-cyan-400"
                    : "text-muted-foreground/70"
                }
              >
                {row.evPct >= 0 ? "+" : ""}
                {row.evPct.toFixed(2)}%
              </span>
              {row.hasValue &&
                (() => {
                  const valueCount = countValueProviders(
                    row.odds,
                    row.valueBetDetails?.trueProb ?? null,
                  );
                  return valueCount > 1 ? (
                    <span className="text-[10px] text-muted-foreground">
                      ·{valueCount}
                    </span>
                  ) : null;
                })()}
            </div>
          ) : (
            <span className="text-muted-foreground/40">-</span>
          )}
        </td>
      )}

      {isVisible("kelly") && (
        <td className="text-center px-2 font-mono text-[11px] tabular-nums">
          {row.hasValue &&
          row.valueBetDetails?.kellyFraction != null &&
          row.valueBetDetails.kellyFraction > 0 ? (
            <span className="text-cyan-600 dark:text-cyan-400/80">
              {(row.valueBetDetails.kellyFraction * 100).toFixed(2)}%
            </span>
          ) : (
            <span className="text-muted-foreground/40">-</span>
          )}
        </td>
      )}

      {/* Provider-odds cells — placeable cells open the placement modal with
          the specific provider's price pre-selected. Non-placeable providers
          remain static. */}
      {(() => {
        // Compute sharp reference sparkline once — passed to soft provider tooltips
        const sharpId = getSharpProviders()[0];
        const sharpMov = sharpId ? row.odds[sharpId]?.movement : undefined;
        const sharpRefData =
          sharpId &&
          sharpMov &&
          sharpMov.totalTicks >= 2 &&
          sharpMov.sparkline.length >= 2
            ? {
                sparkline: sharpMov.sparkline,
                label: getProviderShortName(sharpId),
              }
            : undefined;

        return visibleProviders.map((providerId) => {
          const od = row.odds[providerId];
          const placeable =
            CONFIGURED_BETTING_PROVIDER_IDS.includes(providerId as string) &&
            !!od &&
            !od.suspended;
          const onClick = placeable
            ? () => {
                const price = od!.value;
                const baseline = row.valueBetDetails;
                const details: ValueBetDetails = baseline
                  ? {
                      sharpProvider: baseline.sharpProvider,
                      sharpOdds: baseline.sharpOdds,
                      trueProb: baseline.trueProb,
                      softProvider: providerId,
                      softOdds: price,
                      impliedProb: 1 / price,
                      edge: baseline.trueProb - 1 / price,
                      evPct: (price * baseline.trueProb - 1) * 100,
                      kellyFraction: Math.max(
                        0,
                        ((price - 1) * baseline.trueProb -
                          (1 - baseline.trueProb)) /
                          (price - 1),
                      ),
                      kellyStake: 0,
                      timestamp: od!.timestamp,
                      familyOdds: baseline.familyOdds,
                    }
                  : (() => {
                      const sharp = getSharpProviders()[0] ?? providerId;
                      const sharpOd = row.odds[sharp];
                      const sOdds = sharpOd?.value ?? price;
                      const sProb = sOdds > 1 ? 1 / sOdds : 1 / price;
                      return {
                        sharpProvider: sharp,
                        sharpOdds: sOdds,
                        trueProb: sProb,
                        softProvider: providerId,
                        softOdds: price,
                        impliedProb: 1 / price,
                        edge: 0,
                        evPct: 0,
                        kellyFraction: 0,
                        kellyStake: 0,
                        timestamp: od!.timestamp,
                      };
                    })();
                onSelectValueBet({
                  eventLabel: row.eventLabel,
                  competition: row.competition,
                  startTime: row.startTime,
                  marketLabel: row.marketLabel,
                  outcomeLabel: row.outcomeLabel,
                  atomId: row.atomId,
                  familyId: row.familyId,
                  marketType: row.marketType,
                  details,
                  eventId: row.eventId,
                  providerEventIds,
                  atomOdds: row.odds,
                  liveScore,
                });
              }
            : undefined;

          // Only pass sharp reference to non-sharp providers
          const isThisSharp = providerId === sharpId;

          return (
            <OddsCell
              key={providerId}
              odds={od}
              onClick={onClick}
              providerLabel={getProviderShortName(providerId)}
              onMovementClick={
                !placeable &&
                onMovementClick &&
                od?.movement &&
                od.movement.totalTicks >= 2
                  ? () =>
                      onMovementClick(row.odds, {
                        eventLabel: row.eventLabel,
                        marketLabel: `${row.marketLabel} · ${row.outcomeLabel}`,
                        valueBetDetails: row.valueBetDetails,
                        startTime: row.startTime,
                        marketType: row.marketType,
                        line: row.line,
                        providerCount: row.providerCount,
                      })
                  : undefined
              }
              onOpenMovementModal={
                onMovementClick && od?.movement && od.movement.totalTicks >= 2
                  ? () =>
                      onMovementClick(row.odds, {
                        eventLabel: row.eventLabel,
                        marketLabel: `${row.marketLabel} · ${row.outcomeLabel}`,
                        valueBetDetails: row.valueBetDetails,
                        startTime: row.startTime,
                        marketType: row.marketType,
                        line: row.line,
                        providerCount: row.providerCount,
                      })
                  : undefined
              }
              sharpRef={!isThisSharp ? sharpRefData : undefined}
            />
          );
        });
      })()}

      <td className="text-center px-2">
        <div className="flex items-center justify-center gap-1">
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Feature id="copy-odds">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <LoadingButton
                    variant="secondary"
                    size="icon"
                    className="size-6"
                    title="Copy raw API data"
                    loading={
                      copyingRawData?.startsWith(`${row.eventId}:`) ?? false
                    }
                    icon={Copy}
                    iconClassName="size-3.5"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {eventProviders.map((provider) => {
                    const providerEventId = providerEventIds[provider];
                    return (
                      <DropdownMenuItem
                        key={provider}
                        onClick={() =>
                          onCopyRawData(row.eventId, provider, providerEventId)
                        }
                      >
                        <span
                          className={
                            getProviderBadgeClasses(provider) +
                            " px-1.5 py-0.5 rounded text-xs mr-2"
                          }
                        >
                          {getProviderShortName(provider)}
                        </span>
                        Copy raw data
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </Feature>
          </div>
          {row.isFirstAtomInFamily && (
            <Button
              variant="ghost"
              size="icon"
              className="size-5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => onHide(row.eventId, row.familyId)}
              title="Hide this market"
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
