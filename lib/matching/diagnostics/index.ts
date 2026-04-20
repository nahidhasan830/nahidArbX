/**
 * Match Diagnostics Module
 *
 * Exports all diagnostic functionality.
 */

// Types
export type {
  MatchScoreBreakdown,
  NearMatch,
  NearMatchEvent,
  FailureReason,
  FailurePattern,
  FailurePatternType,
  DiagnosticStats,
} from "./types";

export {
  NEAR_MATCH_MIN_SCORE,
  NEAR_MATCH_MAX_SCORE,
  MAX_NEAR_MATCHES,
  NEAR_MATCH_MAX_AGE_MS,
} from "./types";

// Store
export {
  addNearMatch,
  getNearMatches,
  getNearMatchById,
  updateNearMatchStatus,
  pruneOldNearMatches,
  clearNearMatches,
  setPatterns,
  getPatterns,
  getDiagnosticStats,
  getPendingCount,
  forceReloadStore,
} from "./store";

// Analyzer
export {
  computeDetailedScore,
  analyzeFailureReasons,
  detectAndStoreNearMatch,
  isNearMatch,
  isFullMatch,
} from "./analyzer";

// Reports
export {
  generateDiagnosticReport,
  getNearMatchSummary,
  type DiagnosticReport,
} from "./reports";
