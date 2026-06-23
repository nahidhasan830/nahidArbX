
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

export {
  computeDetailedScore,
  analyzeFailureReasons,
  detectAndStoreNearMatch,
  isNearMatch,
  isFullMatch,
} from "./analyzer";

export {
  generateDiagnosticReport,
  getNearMatchSummary,
  type DiagnosticReport,
} from "./reports";
