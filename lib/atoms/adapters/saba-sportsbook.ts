/**
 * SABA Sportsbook atoms adapter.
 *
 * SABA's fixture endpoint is HTTP, but full-market odds are delivered through
 * a Socket.IO odds channel. This adapter consumes decoded full-match snapshots
 * and maps the supported football markets into the shared atom store.
 */

import { BaseAtomsAdapter, type FetchContext } from "./base";
import { buildOddsEntry } from "../../shared/odds-entry";
import { formatHandicapLine, formatLine } from "../../formatting/lines";
import { sabaSocketClient } from "../../betting/saba/socket-client";
import type { SabaDecodedRow } from "../../betting/saba/socket-parser";
import type { NormalizedOddsEntry, ProviderKey } from "../types";

const PROVIDER: ProviderKey = "saba-sportsbook";

interface SabaRawData {
  rows: SabaDecodedRow[];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asianToDecimal(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null || n === 0) return null;
  const decimal = n > 0 ? 1 + n : 1 + 1 / Math.abs(n);
  return Number(decimal.toFixed(3));
}

function decimalValue(value: unknown): number | null {
  const n = asNumber(value);
  if (n === null || n <= 1) return null;
  return Number(n.toFixed(3));
}

function sabaHomeHandicapLine(row: SabaDecodedRow): number | null {
  const hdp1 = asNumber(row.hdp1);
  if (hdp1 === null) return null;
  const hdp2 = asNumber(row.hdp2) ?? 0;
  return hdp2 - hdp1;
}

function rowMatchId(row: SabaDecodedRow): string | null {
  const value = row.matchid;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return null;
}

function isRequestedMatchRow(
  row: SabaDecodedRow,
  providerEventId: string,
): boolean {
  return rowMatchId(row) === String(providerEventId);
}

function isSuspended(row: SabaDecodedRow): boolean {
  const status = String(row.oddsstatus ?? "").toLowerCase();
  if (status && status !== "running") return true;
  return asNumber(row.enable) === 0;
}

function pushEntry(
  entries: NormalizedOddsEntry[],
  atomId: string,
  odds: number | null,
  eventId: string,
  timestamp: number,
  suspended: boolean,
): void {
  if (odds === null) return;
  const entry = buildOddsEntry(
    PROVIDER,
    eventId,
    atomId,
    odds,
    timestamp,
    suspended || undefined,
  );
  if (entry) entries.push(entry);
}

function handicapEntries(
  row: SabaDecodedRow,
  scope: "ft" | "1h",
  eventId: string,
  timestamp: number,
): NormalizedOddsEntry[] {
  const homeRawLine = sabaHomeHandicapLine(row);
  if (homeRawLine === null) return [];

  const suspended = isSuspended(row);
  const homeLine = formatHandicapLine(homeRawLine);
  const awayLine = formatHandicapLine(-homeRawLine);
  const entries: NormalizedOddsEntry[] = [];

  pushEntry(
    entries,
    `${scope}_home_ah_${homeLine}`,
    asianToDecimal(row.odds1a),
    eventId,
    timestamp,
    suspended,
  );
  pushEntry(
    entries,
    `${scope}_away_ah_${awayLine}`,
    asianToDecimal(row.odds2a),
    eventId,
    timestamp,
    suspended,
  );
  return entries;
}

function totalEntries(
  row: SabaDecodedRow,
  scope: "ft" | "1h",
  eventId: string,
  timestamp: number,
): NormalizedOddsEntry[] {
  const line = asNumber(row.hdp1);
  if (line === null) return [];

  const lineId = formatLine(line);
  const suspended = isSuspended(row);
  const entries: NormalizedOddsEntry[] = [];
  pushEntry(
    entries,
    `${scope}_total_over_${lineId}`,
    asianToDecimal(row.odds1a),
    eventId,
    timestamp,
    suspended,
  );
  pushEntry(
    entries,
    `${scope}_total_under_${lineId}`,
    asianToDecimal(row.odds2a),
    eventId,
    timestamp,
    suspended,
  );
  return entries;
}

function matchResultEntries(
  row: SabaDecodedRow,
  scope: "ft" | "1h",
  eventId: string,
  timestamp: number,
): NormalizedOddsEntry[] {
  const suspended = isSuspended(row);
  const entries: NormalizedOddsEntry[] = [];
  pushEntry(
    entries,
    `${scope}_home_win`,
    decimalValue(row.com1),
    eventId,
    timestamp,
    suspended,
  );
  pushEntry(
    entries,
    `${scope}_away_win`,
    decimalValue(row.com2),
    eventId,
    timestamp,
    suspended,
  );
  pushEntry(
    entries,
    `${scope}_draw`,
    decimalValue(row.comx),
    eventId,
    timestamp,
    suspended,
  );
  return entries;
}

function rowToEntries(
  row: SabaDecodedRow,
  eventId: string,
  timestamp: number,
): NormalizedOddsEntry[] {
  const betType = asNumber(row.bettype);
  if (betType === null) return [];

  const suspended = isSuspended(row);
  const entries: NormalizedOddsEntry[] = [];

  switch (betType) {
    case 1:
      return handicapEntries(row, "ft", eventId, timestamp);
    case 2:
      pushEntry(
        entries,
        "ft_goals_odd",
        asianToDecimal(row.odds1a),
        eventId,
        timestamp,
        suspended,
      );
      pushEntry(
        entries,
        "ft_goals_even",
        asianToDecimal(row.odds2a),
        eventId,
        timestamp,
        suspended,
      );
      return entries;
    case 3:
      return totalEntries(row, "ft", eventId, timestamp);
    case 5:
      return matchResultEntries(row, "ft", eventId, timestamp);
    case 7:
      return handicapEntries(row, "1h", eventId, timestamp);
    case 8:
      return totalEntries(row, "1h", eventId, timestamp);
    case 15:
      return matchResultEntries(row, "1h", eventId, timestamp);
    case 24:
      pushEntry(
        entries,
        "ft_dc_1x",
        decimalValue(row.com1),
        eventId,
        timestamp,
        suspended,
      );
      pushEntry(
        entries,
        "ft_dc_12",
        decimalValue(row.comx),
        eventId,
        timestamp,
        suspended,
      );
      pushEntry(
        entries,
        "ft_dc_x2",
        decimalValue(row.com2),
        eventId,
        timestamp,
        suspended,
      );
      return entries;
    default:
      return [];
  }
}

export class SabaSportsbookAtomsAdapter extends BaseAtomsAdapter {
  readonly providerId: ProviderKey = PROVIDER;

  async onEnable(): Promise<void> {
    const { sabaSyncService } =
      await import("../../services/saba-sync-service");
    sabaSyncService.start();
  }

  protected async fetchRawData(ctx: FetchContext): Promise<SabaRawData | null> {
    const snapshot = await sabaSocketClient.requestFullMatchOdds(
      ctx.providerEventId,
    );
    return { rows: snapshot.rows };
  }

  protected extractOdds(
    rawData: unknown,
    ctx: FetchContext,
  ): NormalizedOddsEntry[] {
    const data = rawData as SabaRawData;
    const timestamp = Date.now();
    const entries: NormalizedOddsEntry[] = [];

    for (const row of data.rows) {
      if (row.type !== "o") continue;
      if (!isRequestedMatchRow(row, ctx.providerEventId)) continue;
      entries.push(...rowToEntries(row, ctx.normalizedEventId, timestamp));
    }

    return entries;
  }

  onDisable(): void {
    sabaSocketClient.deactivate();
  }
}
