/**
 * Unified Formatting Utilities
 *
 * Central export point for all human-readable label formatters.
 * Import from here instead of individual modules to keep things consistent.
 */

export {
  formatMarketType,
  formatFamilyLabel,
  formatAtomLabel,
  formatTimeScope,
  MARKET_TYPE_LABELS,
} from "./labels";

export {
  formatTeamName,
  formatCompetitionName,
  formatEventTitle,
  applyTeamAlias,
  applyCompetitionAlias,
  normalize,
  normalizeCompetition,
  preNormalizeEvent,
  preNormalizeAll,
  type PreNormalizedNames,
} from "./display";

export {
  eventLabel,
  eventPromptLine,
  type EventLabelSide,
} from "./event-label";

export { fmtDateTime, fmtRelative, fmtMoney, fmtSignedPct } from "./helpers";
