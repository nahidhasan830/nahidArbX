/**
 * Atoms Type Definitions
 *
 * Core types for the family/atom-based market model.
 * All types derived from atoms.json structure.
 */

import type { ProviderKey } from "../providers/registry";

// Time scopes
export type TimeScope = "FT" | "1H" | "2H";

// Market types (from atoms.json)
export type AtomMarketType =
  | "MATCH_RESULT"
  | "TOTAL_GOALS"
  | "ASIAN_HANDICAP"
  | "EUROPEAN_HANDICAP"
  | "BTTS"
  | "DNB"
  | "DOUBLE_CHANCE"
  | "HOME_TEAM_TOTAL"
  | "AWAY_TEAM_TOTAL"
  | "CORNERS"
  | "CORNERS_HANDICAP"
  | "CORNERS_EUROPEAN_HANDICAP"
  | "HOME_CORNERS_TOTAL"
  | "AWAY_CORNERS_TOTAL"
  | "BOOKINGS"
  | "BOOKINGS_HANDICAP"
  // New market types
  | "ODD_EVEN_GOALS"
  | "CLEAN_SHEET"
  | "WIN_TO_NIL"
  | "TO_SCORE";

// Family types
export type FamilyType = "pair" | "group";

// Family definition (matches atoms.json structure)
export interface Family {
  id: string;
  type: FamilyType;
  time_scope: TimeScope;
  market_type: AtomMarketType;
  line?: number;
  is_split_settlement?: boolean;
  atoms: string[];
}

// Atoms registry structure
export interface AtomsRegistry {
  families: Record<string, Family>;
}

// Provider identifier - imported from central registry
export { type ProviderKey } from "../providers/registry";

// Odds source type - re-exported from central types for backward compatibility
// Use OddsSource from lib/types.ts as the single source of truth
export { type OddsSource as OddsSourceType } from "../types";

// Odds record stored per provider
export interface OddsRecord {
  odds: number;
  timestamp: number;
  suspended?: boolean; // Market is suspended (show odds but mark as unavailable)
}

// Normalized odds entry (used for storing odds)
export interface NormalizedOddsEntry {
  provider: ProviderKey;
  event_id: string;
  family_id: string;
  atom_id: string;
  odds: number;
  timestamp: number;
  suspended?: boolean; // Market is suspended (show odds but mark as unavailable)
}

// Best odds result for an atom
export interface BestAtomOdds {
  atomId: string;
  odds: number;
  provider: ProviderKey;
  timestamp: number; // When these odds were fetched (for staleness check)
}

// Re-export ValueBet type from value-detector for convenience
export type {
  ValueBet,
  ValueDetectionOptions,
  ValueDetectionStats,
} from "./value-detector";
