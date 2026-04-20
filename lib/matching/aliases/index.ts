/**
 * Alias System Module
 *
 * Exports all alias functionality.
 */

// Store
export type { AliasEntry, AliasFile } from "./store";

export {
  getTeamAliases,
  getAllTeamAliases,
  addTeamAlias,
  removeTeamAlias,
  getCompetitionAliases,
  getAllCompetitionAliases,
  addCompetitionAlias,
  removeCompetitionAlias,
  clearAliasCache,
  getAliasStats,
} from "./store";

// Learner
export type { LearnedAliases } from "./learner";

export {
  learnFromConfirmedMatch,
  confirmNearMatch,
  rejectNearMatch,
  autoConfirmHighConfidence,
} from "./learner";
