
import {
  PROVIDER_IDS,
  getProviderShortName,
  type ProviderKey,
} from "@/lib/providers/registry";
import { eventLabel } from "@/lib/formatting/event-label";

function computePriority(
  evPct: number | null,
  timestamp: number,
): number | null {
  if (evPct === null || evPct <= 0) return null;
  const normalizedEv = Math.min(evPct / 100, 1);
  const ageMs = Date.now() - timestamp;
  const freshness = Math.max(0, 1 - ageMs / 180_000);
  return normalizedEv * 0.6 + freshness * 0.4;
}


export interface AtomOddsData {
  value: number;
  timestamp: number;
  isBest: boolean;
  suspended?: boolean;
  movement?: {
    direction: "up" | "down" | "stable";
    changePct: number;
    openingOdds: number | null;
    peakOdds: number;
    troughOdds: number;
    totalTicks: number;
    sparkline: [number, number][];
    steamMove: {
      direction: "up" | "down";
      magnitudePct: number;
      significance: "weak" | "moderate" | "strong";
    } | null;
  };
}

export interface SpreadsheetRow {
  rowId: string;
  eventId: string;
  eventLabel: string;
  competition: string;
  startTime: string;
  familyId: string;
  marketLabel: string;
  marketType: string;
  timeScope: string;
  line?: number;
  atomId: string;
  outcomeLabel: string;
  odds: Partial<Record<ProviderKey, AtomOddsData>>;
  providerCount: number;
  bestOdds: number | null;
  bestProvider: ProviderKey | null;
  evPct: number | null;
  trueOdds: number | null;
  kellyStake: number | null;
  valueSoftProvider: ProviderKey | null;
  hasValue: boolean;
  priorityScore: number | null;
  valueBetDetails: {
    sharpProvider: ProviderKey;
    sharpOdds: number;
    trueProb: number;
    softProvider: ProviderKey;
    softOdds: number;
    impliedProb: number;
    edge: number;
    evPct: number;
    kellyFraction: number;
    kellyStake: number;
    timestamp: number;
    familyOdds?: {
      totalImpliedProb: number;
      vigPct: number;
      atoms: {
        atomId: string;
        label: string;
        rawOdds: number;
        rawProb: number;
        trueProb: number;
      }[];
    };
  } | null;
  isFirstAtomInFamily: boolean;
  isFirstFamilyInEvent: boolean;
  isLastAtomInEvent: boolean;
}

export interface BulkAtomResult {
  atomId: string;
  label: string;
  oddsByProvider: Partial<
    Record<
      ProviderKey,
      {
        odds: number;
        timestamp: number;
        isBest: boolean;
        suspended?: boolean;
        movement?: AtomOddsData["movement"];
      }
    >
  >;
  bestOdds: number | null;
  bestProvider: string | null;
  valueBet?: {
    softProvider: string;
    sharpProvider: string;
    softOdds: number;
    sharpOdds: number;
    trueProb: number;
    trueOdds: number;
    impliedProb: number;
    evPct: number;
    edge: number;
    kellyFraction: number;
    kellyStake: number;
    timestamp: number;
    familyOdds?: {
      totalImpliedProb: number;
      vigPct: number;
      atoms: {
        atomId: string;
        label: string;
        rawOdds: number;
        rawProb: number;
        trueProb: number;
      }[];
    };
  };
}

export interface BulkFamilyResult {
  familyId: string;
  label: string;
  marketType: string;
  timeScope: string;
  line?: number;
  atoms: BulkAtomResult[];
}

export interface DisplayScore {
  home: number;
  away: number;
  minute: number;
  period: string;
  homeRedCards: number;
  awayRedCards: number;
}

export interface ValueBetEvent {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
  providers: string[];
  providerEventIds?: Record<string, string>;
  families: BulkFamilyResult[];
  liveScore?: DisplayScore;
  suspended?: boolean;
}

export type TimeFilter = "all" | "live" | "upcoming";

export interface TransformOptions {
  selectedProviders?: Set<ProviderKey>;
  showOnlyValue?: boolean;
  minEvPct?: number;
  searchTerm?: string;
  selectedMarketTypes?: Set<string>;
  timeFilter?: TimeFilter;
}


export function transformToSpreadsheetRows(
  events: ValueBetEvent[],
  options: TransformOptions = {},
): SpreadsheetRow[] {
  const {
    selectedProviders = new Set(PROVIDER_IDS),
    showOnlyValue = false,
    minEvPct = 0,
    searchTerm = "",
    selectedMarketTypes = new Set<string>(), // Empty set means "all"
    timeFilter = "all",
  } = options;

  const rows: SpreadsheetRow[] = [];
  const searchLower = searchTerm.toLowerCase().trim();
  const now = Date.now();

  const eventsWithValue = new Set<string>();
  if (showOnlyValue) {
    for (const event of events) {
      if (
        event.families.some((f) =>
          f.atoms.some((a) => a.valueBet && a.valueBet.evPct >= minEvPct),
        )
      ) {
        eventsWithValue.add(event.eventId);
      }
    }
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];

    if (timeFilter !== "all") {
      const eventStart = new Date(event.startTime).getTime();
      if (timeFilter === "live" && eventStart > now) continue;
      if (timeFilter === "upcoming" && eventStart <= now) continue;
    }

    if (searchLower) {
      const eventSearchable =
        `${event.homeTeam} ${event.awayTeam} ${event.competition}`.toLowerCase();
      if (!eventSearchable.includes(searchLower)) continue;
    }

    let isFirstFamilyInEvent = true;

    for (
      let familyIndex = 0;
      familyIndex < event.families.length;
      familyIndex++
    ) {
      const family = event.families[familyIndex];

      if (
        selectedMarketTypes.size > 0 &&
        !selectedMarketTypes.has(family.marketType)
      )
        continue;

      let isFirstAtomInFamily = true;

      for (const atom of family.atoms) {
        const providerCount = Object.keys(atom.oddsByProvider).filter(
          (p) =>
            selectedProviders.has(p as ProviderKey) &&
            atom.oddsByProvider[p as ProviderKey],
        ).length;

        const hasValue = !!atom.valueBet && atom.valueBet.evPct >= minEvPct;

        if (showOnlyValue && !hasValue) continue;

        const odds: Partial<Record<ProviderKey, AtomOddsData>> = {};
        let bestOdds: number | null = null;
        let bestProvider: ProviderKey | null = null;

        for (const providerId of selectedProviders) {
          const providerOdds = atom.oddsByProvider[providerId];
          if (providerOdds) {
            odds[providerId] = {
              value: providerOdds.odds,
              timestamp: providerOdds.timestamp,
              isBest: providerOdds.isBest,
              suspended: providerOdds.suspended,
              movement: providerOdds.movement as AtomOddsData["movement"],
            };
            if (
              providerOdds.isBest ||
              bestOdds === null ||
              providerOdds.odds > bestOdds
            ) {
              if (providerOdds.isBest) {
                bestOdds = providerOdds.odds;
                bestProvider = providerId;
              } else if (bestOdds === null || providerOdds.odds > bestOdds) {
                bestOdds = providerOdds.odds;
                bestProvider = providerId;
              }
            }
          }
        }

        const row: SpreadsheetRow = {
          rowId: `${event.eventId}|${family.familyId}|${atom.atomId}`,
          eventId: event.eventId,
          eventLabel: eventLabel(event),
          competition: event.competition,
          startTime: event.startTime,
          familyId: family.familyId,
          marketLabel: family.label,
          marketType: family.marketType,
          timeScope: family.timeScope,
          line: family.line,
          atomId: atom.atomId,
          outcomeLabel: atom.label,
          odds,
          providerCount,
          bestOdds,
          bestProvider,
          evPct: atom.valueBet?.evPct ?? null,
          trueOdds: atom.valueBet?.trueOdds ?? null,
          kellyStake: atom.valueBet?.kellyStake ?? null,
          valueSoftProvider:
            (atom.valueBet?.softProvider as ProviderKey) ?? null,
          hasValue,
          priorityScore: hasValue
            ? computePriority(
                atom.valueBet?.evPct ?? null,
                Object.values(odds).find((o) => o)?.timestamp ?? now,
              )
            : null,
          valueBetDetails: atom.valueBet
            ? {
                sharpProvider: atom.valueBet.sharpProvider as ProviderKey,
                sharpOdds: atom.valueBet.sharpOdds,
                trueProb: atom.valueBet.trueProb,
                softProvider: atom.valueBet.softProvider as ProviderKey,
                softOdds: atom.valueBet.softOdds,
                impliedProb: atom.valueBet.impliedProb,
                edge: atom.valueBet.edge,
                evPct: atom.valueBet.evPct,
                kellyFraction: atom.valueBet.kellyFraction,
                kellyStake: atom.valueBet.kellyStake,
                timestamp: atom.valueBet.timestamp,
                familyOdds: atom.valueBet.familyOdds,
              }
            : null,
          isFirstAtomInFamily,
          isFirstFamilyInEvent,
          isLastAtomInEvent: false, // Will be recalculated after filtering
        };

        rows.push(row);
        isFirstAtomInFamily = false;
        isFirstFamilyInEvent = false;
      }
    }
  }

  return rows;
}

export function getUniqueMarketTypes(events: ValueBetEvent[]): string[] {
  const types = new Set<string>();
  for (const event of events) {
    for (const family of event.families) {
      types.add(family.marketType);
    }
  }
  return Array.from(types).sort();
}


export function formatRowsAsReadableTable(
  rows: SpreadsheetRow[],
  visibleProviders: ProviderKey[],
  hiddenColumns?: Set<string>,
): string {
  if (rows.length === 0) return "No data to copy";

  const isVisible = (colId: string) => !hiddenColumns?.has(colId);

  type ColumnDef = {
    id: string;
    header: string;
    getValue: (row: SpreadsheetRow) => string;
  };

  const baseColumns: ColumnDef[] = [
    { id: "event", header: "Event", getValue: (r) => r.eventLabel },
    {
      id: "competition",
      header: "Competition",
      getValue: (r) => r.competition,
    },
    { id: "market", header: "Market", getValue: (r) => r.marketLabel },
    { id: "outcome", header: "Outcome", getValue: (r) => r.outcomeLabel },
  ];

  const providerColumns: ColumnDef[] = visibleProviders.map((p) => ({
    id: p,
    header: getProviderShortName(p),
    getValue: (r: SpreadsheetRow) => r.odds[p]?.value?.toFixed(2) ?? "-",
  }));

  const analysisColumns: ColumnDef[] = [
    {
      id: "best",
      header: "Best",
      getValue: (r) => r.bestOdds?.toFixed(2) ?? "-",
    },
    {
      id: "best",
      header: "Provider",
      getValue: (r) =>
        r.bestProvider ? getProviderShortName(r.bestProvider) : "-",
    },
  ];

  const allColumns = [
    ...baseColumns.filter((c) => isVisible(c.id)),
    ...providerColumns, // Provider visibility handled via visibleProviders param
    ...analysisColumns.filter((c) => isVisible(c.id)),
  ];

  const headers = allColumns.map((c) => c.header);

  const lines: string[] = [];

  lines.push(`| ${headers.join(" | ")} |`);

  lines.push(`|${headers.map(() => "---").join("|")}|`);

  for (const row of rows) {
    const values = allColumns.map((c) => c.getValue(row));
    lines.push(`| ${values.join(" | ")} |`);
  }

  return lines.join("\n");
}


export interface SpreadsheetStats {
  totalRows: number;
  uniqueEvents: number;
  uniqueFamilies: number;
  rowsWithValue: number;
  bestEvPct: number | null;
  providerCounts: Record<ProviderKey, number>;
}

export function calculateSpreadsheetStats(
  rows: SpreadsheetRow[],
): SpreadsheetStats {
  const eventIds = new Set<string>();
  const familyIds = new Set<string>();
  let rowsWithValue = 0;
  let bestEvPct: number | null = null;
  const providerCounts: Partial<Record<ProviderKey, number>> = {};

  for (const row of rows) {
    eventIds.add(row.eventId);
    familyIds.add(`${row.eventId}|${row.familyId}`);

    if (row.hasValue) {
      rowsWithValue++;
      if (row.evPct !== null && (bestEvPct === null || row.evPct > bestEvPct)) {
        bestEvPct = row.evPct;
      }
    }

    for (const providerId of PROVIDER_IDS) {
      if (row.odds[providerId]) {
        providerCounts[providerId] = (providerCounts[providerId] ?? 0) + 1;
      }
    }
  }

  return {
    totalRows: rows.length,
    uniqueEvents: eventIds.size,
    uniqueFamilies: familyIds.size,
    rowsWithValue,
    bestEvPct,
    providerCounts: providerCounts as Record<ProviderKey, number>,
  };
}
