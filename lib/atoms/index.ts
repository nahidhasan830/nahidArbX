/**
 * Atoms Module
 *
 * Family/Atom-based market model for value-bet detection.
 * Provides:
 * - Type definitions
 * - Registry lookups
 * - Odds storage
 * - Provider mappings
 * - Value-bet detection (sharp vs. soft)
 */

// ============================================
// Types
// ============================================

export type {
  TimeScope,
  AtomMarketType,
  FamilyType,
  Family,
  AtomsRegistry,
  ProviderKey,
  OddsSourceType,
  OddsRecord,
  NormalizedOddsEntry,
  BestAtomOdds,
} from "./types";

// ============================================
// Registry
// ============================================

export {
  getFamily,
  getFamilyByAtom,
  getFamilyIdByAtom,
  isValidAtom,
  getAtomsInFamily,
  getAllFamilies,
  getAllFamilyIds,
  getFamiliesByMarketType,
  findFamily,
  getRegistryStats,
} from "./registry";

// ============================================
// Store
// ============================================

export {
  setOdds,
  setOddsBatch,
  getOdds,
  getAllOddsForAtom,
  getBestOddsForAtom,
  getBestOddsForFamily,
  getFamiliesForEvent,
  getAllEventIds,
  clearAllOdds,
  getStoreStats,
} from "./store";

// ============================================
// Provider Mappings
// ============================================

// Pinnacle
export {
  mapPinnacleToAtom,
  extractPinnacleOdds,
  type PinnacleMarketTuple,
  type PinnacleOutcomeTuple,
} from "./mappings/pinnacle";

// NineWickets Exchange
export {
  mapExchangeToAtom,
  extractExchangeOdds,
  type ExchangeMarket,
  type ExchangeSelection,
} from "./mappings/ninewickets-exchange";

// NineWickets Sportsbook
export {
  mapSportsbookToAtom,
  extractSportsbookOdds,
  SPORTSBOOK_MARKET_TYPES,
  type SportsbookMarket,
  type SportsbookSelection,
} from "./mappings/ninewickets-sportsbook";
