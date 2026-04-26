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
  getMarketOptions,
  MARKET_TYPE_LABELS,
  type MarketOption,
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

export {
  fmtDateTime,
  fmtSeen,
  fmtRelative,
  fmtMoney,
  fmtSignedPct,
} from "./helpers";
