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
import { getPriorityScore } from "@/lib/atoms/priority-score";
import { eventLabel } from "@/lib/formatting/event-label";
import type { SortMode } from "@/components/hooks/useBulkAnalysisPreferences";

// ============================================
// Types
// ============================================

export interface AtomOddsData {
  value: number;
  timestamp: number;
  isBest: boolean;
  suspended?: boolean; // Market is suspended (show but mark as unavailable)
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
  isSuspicious: boolean; // True if odds differ > 30% between providers (possible mapping error)
}

// Matches the API response shape from bulk-analyze
export interface BulkAtomResult {
  atomId: string;
  label: string;
  oddsByProvider: Partial<
    Record<
      ProviderKey,
      { odds: number; timestamp: number; isBest: boolean; suspended?: boolean }
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

export interface BulkEventResult {
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
  minProviderCount?: number;
  showOnlyValue?: boolean; // Filter to show only value bets
  minEvPct?: number; // Minimum EV% to show (default 0)
  searchTerm?: string;
  selectedMarketTypes?: Set<string>; // Empty set means "all"
  timeFilter?: TimeFilter;
  suspiciousThresholdPct?: number; // Default 30 (ratio > 1.3)
  // Sorting options
  sortMode?: SortMode; // How to sort value bets (default "priority")
  filterHighEv?: boolean; // Filter out EV > maxEvPctFilter (default true)
  maxEvPctFilter?: number; // Max EV% threshold for filtering (default 15)
}

// ============================================
// Transform Functions
// ============================================

/**
 * Transform hierarchical bulk results to flat spreadsheet rows
 */
export function transformToSpreadsheetRows(
  events: BulkEventResult[],
  options: TransformOptions = {},
): SpreadsheetRow[] {
  const {
    selectedProviders = new Set(PROVIDER_IDS),
    minProviderCount = 2,
    showOnlyValue = false,
    minEvPct = 0,
    searchTerm = "",
    selectedMarketTypes = new Set<string>(), // Empty set means "all"
    timeFilter = "all",
    suspiciousThresholdPct = 30,
    sortMode = "priority",
    filterHighEv = true,
    maxEvPctFilter = 15,
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

    // Filter by search term (event level)
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

        // Filter by min provider count
        if (providerCount < minProviderCount) continue;

        // Check if this atom has a value bet meeting threshold
        const hasValue = !!atom.valueBet && atom.valueBet.evPct >= minEvPct;

        // Filter by value bet if showOnlyValue is on
        if (showOnlyValue && !hasValue) continue;

        // Filter out high EV bets (potential palpable errors)
        if (
          filterHighEv &&
          hasValue &&
          (atom.valueBet?.evPct ?? 0) > maxEvPctFilter
        )
          continue;

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

        // Detect suspicious odds difference (configurable threshold).
        // Wide provider-to-provider spreads usually indicate a mapping error
        // rather than a genuine value edge — flag them for review.
        const activeOdds = Object.values(odds)
          .filter((o): o is AtomOddsData => o !== undefined && !o.suspended)
          .map((o) => o.value);
        let isSuspicious = false;
        if (activeOdds.length >= 2) {
          const ratio = Math.max(...activeOdds) / Math.min(...activeOdds);
          const thresholdRatio = 1 + suspiciousThresholdPct / 100;
          isSuspicious = ratio > thresholdRatio;
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
            ? getPriorityScore({
                evPct: atom.valueBet?.evPct ?? null,
                kellyStake: atom.valueBet?.kellyStake ?? null,
                timestamp: Object.values(odds).find((o) => o)?.timestamp ?? now,
                isSuspicious,
              })
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
          isSuspicious,
        };

        rows.push(row);
        isFirstAtomInFamily = false;
        isFirstFamilyInEvent = false;
      }
    }
  }

  // Apply sorting based on sortMode
  return sortSpreadsheetRows(rows, sortMode);
}

/**
 * Sort spreadsheet rows based on sort mode
 */
function sortSpreadsheetRows(
  rows: SpreadsheetRow[],
  sortMode: SortMode,
): SpreadsheetRow[] {
  if (sortMode === "default") {
    return rows; // Keep original order (grouped by event/family)
  }

  return [...rows].sort((a, b) => {
    switch (sortMode) {
      case "priority":
        return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
      case "ev":
        return (b.evPct ?? 0) - (a.evPct ?? 0);
      case "kelly":
        return (b.kellyStake ?? 0) - (a.kellyStake ?? 0);
      case "freshness": {
        // Sort by most recent odds timestamp
        const aTs = Math.max(
          ...Object.values(a.odds)
            .filter((o): o is AtomOddsData => o !== undefined)
            .map((o) => o.timestamp),
        );
        const bTs = Math.max(
          ...Object.values(b.odds)
            .filter((o): o is AtomOddsData => o !== undefined)
            .map((o) => o.timestamp),
        );
        return bTs - aTs;
      }
      default:
        return 0;
    }
  });
}

/**
 * Get unique market types from events for filter dropdown
 */
export function getUniqueMarketTypes(events: BulkEventResult[]): string[] {
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
