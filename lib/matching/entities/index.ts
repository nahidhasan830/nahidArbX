/**
 * Entity Resolution — public surface.
 *
 * Single import point for the matcher, settle, match-review, and UI layers.
 * The legacy 4-tier promoter / scheduler / classifier are gone.
 * `recordObservation()` now triggers `autoResolve()` inline, and the
 * Vertex embedding path handles similarity scoring before operator review.
 */

export {
  recordObservation,
  ensureCompetitionEntity,
  ensureTeamEntity,
  type RecordObservationInput,
} from "./observations";

export {
  resolveTeamSurface,
  resolveCompetitionSurface,
  clearResolverCache,
  notifyResolverInvalidation,
  startResolverCacheListener,
  isResolverCacheListenerActive,
  type ResolvedSurface,
} from "./resolver";

export {
  autoResolve,
  type AutoResolveResult,
  type AutoResolveDecision,
  type AutoResolveStage,
} from "./auto-resolve";

export {
  scoreBiEncoder,
  scoreCrossEncoder,
  embed,
  reloadCalibrator,
  checkHealthz,
  type MatcherScore,
} from "./matcher-client";

export {
  addBlocklistEntry,
  isBlocked,
  sweepExpiredBlocklist,
  type BlocklistEntry,
} from "./blocklist";

export { harvestMatchPair } from "./match-harvester";

export {
  normalize,
  normalizeCompetition,
  isWomensTeam,
  gendersDiffer,
  ageClassOf,
  ageClassesDiffer,
} from "./normalize";
