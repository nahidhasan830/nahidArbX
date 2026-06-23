export { matchEvents } from "./matcher";
export type { MatchResult } from "./matcher";
export { resetMatchCache, getMatchCacheStats } from "./match-cache";
export { getMatchingConfig, updateMatchingConfig } from "./config";
export type { MatchSource, MatchingConfig } from "./config";

export {
  recordObservation,
  resolveTeamSurface,
  resolveCompetitionSurface,
  startResolverCacheListener,
  isResolverCacheListenerActive,
} from "./entities";
