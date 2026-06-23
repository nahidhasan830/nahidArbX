
import type { ProviderKey } from "../providers/registry";

export type TimeScope = "FT" | "1H" | "2H";

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
  | "ODD_EVEN_GOALS"
  | "CLEAN_SHEET"
  | "WIN_TO_NIL"
  | "TO_SCORE";

export type FamilyType = "pair" | "group";

export interface Family {
  id: string;
  type: FamilyType;
  time_scope: TimeScope;
  market_type: AtomMarketType;
  line?: number;
  is_split_settlement?: boolean;
  atoms: string[];
}

export interface AtomsRegistry {
  families: Record<string, Family>;
}

export { type ProviderKey } from "../providers/registry";

export { type OddsSource as OddsSourceType } from "../types";

export interface OddsRecord {
  odds: number;
  timestamp: number;
  suspended?: boolean;
}

export interface NormalizedOddsEntry {
  provider: ProviderKey;
  event_id: string;
  family_id: string;
  atom_id: string;
  odds: number;
  timestamp: number;
  suspended?: boolean;
}

export interface BestAtomOdds {
  atomId: string;
  odds: number;
  provider: ProviderKey;
  timestamp: number;
}

export type {
  ValueBet,
  ValueDetectionOptions,
  ValueDetectionStats,
} from "./value-detector";
