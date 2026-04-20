/**
 * Pinnacle API Module
 *
 * Barrel export for all Pinnacle-related utilities.
 * Import from here instead of individual files.
 */

// Schemas and types
export {
  SOCCER_SPORT_ID,
  // Element schemas
  OutcomeSchema,
  MarketSchema,
  PeriodSchema,
  EventSchema,
  LeagueSchema,
  StatusGroupSchema,
  // Response schemas
  PinnacleEventsResponseSchema,
  PinnacleEventMarketsResponseSchema,
  // Legacy aliases
  PinnacleResponseSchema,
  SportSchemaForEventsList,
  SportSchemaForSingleEvent,
  // Types
  type PinnacleEventsResponse,
  type PinnacleEventMarketsResponse,
  type PinnacleEvent,
  type PinnaclePeriod,
  type PinnacleMarket,
  type PinnacleOutcome,
  type PinnacleResponse,
} from "./schemas";

// URL builders
export { buildEventsUrl, buildEventMarketsUrl } from "./urls";

// Client and fetch helpers
export {
  pinnacleClient,
  fetchWithTokenRefresh,
  fetchWithToken,
  type FetchResult,
} from "./client";
