export { matchEvents } from "./matcher";
export type { MatchResult } from "./matcher";
export { resetMatchCache, getMatchCacheStats } from "./match-cache";
export { getMatchingConfig, updateMatchingConfig } from "./config";
export type { MatchSource, MatchingConfig } from "./config";

// Entity-resolution v2 — auto-resolver replaces the 4-tier promoter +
// scheduler. The cache invalidation listener boots from instrumentation.ts.
export {
  recordObservation,
  resolveTeamSurface,
  resolveCompetitionSurface,
  startResolverCacheListener,
  isResolverCacheListenerActive,
} from "./entities";
