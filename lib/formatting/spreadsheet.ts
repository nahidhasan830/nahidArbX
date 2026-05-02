/**
 * Spreadsheet View Data Transformation
 *
 * Transforms hierarchical bulk analysis results (Event → Family → Atom)
 * into flat spreadsheet rows for easier cross-provider comparison.
 */

import {
  PROVIDER_IDS,
  getProviderShortName,
  type ProviderKey,
} from "@/lib/providers/registry";
import { eventLabel } from "@/lib/formatting/event-label";

/**
 * Inline priority score — ranks value bets by quality.
 * No EV cap, no suspicious penalty. Just a simple quality ranking.
 */
function computePriority(evPct: number | null, timestamp: number): number | null {
  if (evPct === null || evPct <= 0) return null;
  const normalizedEv = Math.min(evPct / 100, 1); // normalize to 0-1, uncapped
  const ageMs = Date.now() - timestamp;
  const freshness = Math.max(0, 1 - ageMs / 180_000); // 3min window
  return normalizedEv * 0.6 + freshness * 0.4;
}

// ============================================
// Types
// ============================================

export interface AtomOddsData {
  value: number;
  timestamp: number;
  isBest: boolean;
  suspended?: boolean; // Market is suspended (show but mark as unavailable)
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
  rowId: string; // `${eventId}|${familyId}|${atomId}`
  eventId: string;
  eventLabel: string; // "Home vs Away"
  competition: string;
  startTime: string;
  familyId: string;
  marketLabel: string; // "Match Result FT" or "O/U 2.5 FT"
  marketType: string;
  timeScope: string;
  line?: number;
  atomId: string;
  outcomeLabel: string; // "Home", "Draw", "Away", "Over", "Under"
  odds: Partial<Record<ProviderKey, AtomOddsData>>;
  providerCount: number;
  bestOdds: number | null;
  bestProvider: ProviderKey | null;
  // Value betting fields
  evPct: number | null; // Expected value % (positive = value bet)
  trueOdds: number | null; // Pinnacle true odds (vig-removed)
  kellyStake: number | null; // Recommended Kelly stake
  valueSoftProvider: ProviderKey | null; // Which soft book has value
  hasValue: boolean; // Quick check for any value bet
  priorityScore: number | null; // Composite priority score (0-1)
  // Full value bet details (for modal display)
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
    // Full family odds for manual verification
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
  isLastAtomInEvent: boolean; // Last row in event (for showing actions at bottom)
}

// Matches the API response shape from bulk-analyze
export interface BulkAtomResult {
  atomId: string;
  label: string;
  oddsByProvider: Partial<
    Record<
      ProviderKey,
      { odds: number; timestamp: number; isBest: boolean; suspended?: boolean; movement?: AtomOddsData["movement"] }
    >
  >;
  bestOdds: number | null;
  bestProvider: string | null;
  // Value bet info (if this atom has positive EV at any soft bookmaker)
  valueBet?: {
    // Core identifiers
    softProvider: string;
    sharpProvider: string;
    // Odds data
    softOdds: number;
    sharpOdds: number;
    // Probability data
    trueProb: number;
    trueOdds: number;
    impliedProb: number;
    // Value metrics
    evPct: number;
    edge: number;
    kellyFraction: number;
    kellyStake: number;
    // Timestamp
    timestamp: number;
    // Full family odds for manual verification
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

/** Live score display data */
export interface DisplayScore {
  home: number;
  away: number;
  minute: number;
  period: string; // "1H", "2H", "HT", "FT", etc.
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
  /** Provider-specific event IDs for raw data fetching */
  providerEventIds?: Record<string, string>;
  /** Market families with per-family odds + value-bet detection data */
  families: BulkFamilyResult[];
  /** Live score data (only for live/in-play events) */
  liveScore?: DisplayScore;
  /** Event-level suspension (all markets blocked) - from BetConstruct is_blocked */
  suspended?: boolean;
}

export type TimeFilter = "all" | "live" | "upcoming";

export interface TransformOptions {
  selectedProviders?: Set<ProviderKey>;
  showOnlyValue?: boolean; // Filter to show only value bets
  minEvPct?: number; // Minimum EV% to show (default 0)
  searchTerm?: string;
  selectedMarketTypes?: Set<string>; // Empty set means "all"
  timeFilter?: TimeFilter;
}

// ============================================
// Transform Functions
// ============================================

/**
 * Transform hierarchical bulk results to flat spreadsheet rows
 */
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

    // Filter by time (live vs upcoming)
    if (timeFilter !== "all") {
      const eventStart = new Date(event.startTime).getTime();
      if (timeFilter === "live" && eventStart > now) continue;
      if (timeFilter === "upcoming" && eventStart <= now) continue;
    }

    // Filter by search term (event names only — use Markets filter for market types)
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

      // Filter by market type
      if (
        selectedMarketTypes.size > 0 &&
        !selectedMarketTypes.has(family.marketType)
      )
        continue;

      let isFirstAtomInFamily = true;

      for (const atom of family.atoms) {
        // Count providers for this atom within selected providers
        const providerCount = Object.keys(atom.oddsByProvider).filter(
          (p) =>
            selectedProviders.has(p as ProviderKey) &&
            atom.oddsByProvider[p as ProviderKey],
        ).length;

        // Check if this atom has a value bet meeting threshold
        const hasValue = !!atom.valueBet && atom.valueBet.evPct >= minEvPct;

        // Filter by value bet if showOnlyValue is on
        if (showOnlyValue && !hasValue) continue;

        // Build odds record with only selected providers
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
          // Value betting fields
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

  // Click-to-sort on column headers is applied in the ValueBetSpreadsheet
  // component (event-group aware — keeps atoms within a family together).
  return rows;
}

/**
 * Get unique market types from events for filter dropdown
 */
export function getUniqueMarketTypes(events: ValueBetEvent[]): string[] {
  const types = new Set<string>();
  for (const event of events) {
    for (const family of event.families) {
      types.add(family.marketType);
    }
  }
  return Array.from(types).sort();
}

// ============================================
// Clipboard Formatting
// ============================================

/**
 * Format rows as a human-readable aligned table for clipboard
 * Respects column visibility settings from the UI
 */
export function formatRowsAsReadableTable(
  rows: SpreadsheetRow[],
  visibleProviders: ProviderKey[],
  hiddenColumns?: Set<string>,
): string {
  if (rows.length === 0) return "No data to copy";

  // Helper to check if column is visible
  const isVisible = (colId: string) => !hiddenColumns?.has(colId);

  // Define column structure with visibility checks
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

  // Provider columns (always respect visibleProviders)
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

  // Filter columns based on visibility
  const allColumns = [
    ...baseColumns.filter((c) => isVisible(c.id)),
    ...providerColumns, // Provider visibility handled via visibleProviders param
    ...analysisColumns.filter((c) => isVisible(c.id)),
  ];

  const headers = allColumns.map((c) => c.header);

  // Build Markdown table
  const lines: string[] = [];

  // Header row: | Col1 | Col2 | ... |
  lines.push(`| ${headers.join(" | ")} |`);

  // Separator row: |------|------|-----|
  lines.push(`|${headers.map(() => "---").join("|")}|`);

  // Data rows: | val1 | val2 | ... |
  for (const row of rows) {
    const values = allColumns.map((c) => c.getValue(row));
    lines.push(`| ${values.join(" | ")} |`);
  }

  return lines.join("\n");
}

// ============================================
// Statistics
// ============================================

export interface SpreadsheetStats {
  totalRows: number;
  uniqueEvents: number;
  uniqueFamilies: number;
  rowsWithValue: number; // Rows with positive EV
  bestEvPct: number | null; // Highest EV% in the view
  providerCounts: Record<ProviderKey, number>;
}

/**
 * Calculate statistics from spreadsheet rows
 */
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
