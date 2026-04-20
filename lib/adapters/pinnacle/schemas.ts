/**
 * Pinnacle API Zod Schemas
 *
 * Single source of truth for all Pinnacle API response validation.
 * Used by both events adapter and atoms adapter.
 */

import { z } from "zod";

// Sport ID for Soccer in Pinnacle
export const SOCCER_SPORT_ID = 29;

// ============================================================
// Shared Element Schemas
// ============================================================

// Outcome: exactly 5 elements [odds, handicap, side, direction, originalOdds]
export const OutcomeSchema = z.tuple([
  z.number().nullable(),
  z.number().nullable(),
  z.string(),
  z.string(),
  z.number().nullable(),
]);

// Market: exactly 19 elements
export const MarketSchema = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.string(),
  z.boolean(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.string(),
  z.number(),
  z.array(OutcomeSchema),
  z.number(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.number(),
]);

// Period: exactly 7 elements
export const PeriodSchema = z.tuple([
  z.number(),
  z.number(),
  z.string(),
  z.string(),
  z.boolean(),
  z.array(MarketSchema),
  z.number(),
]);

// Event: exactly 8 elements
export const EventSchema = z.tuple([
  z.number(), // [0] eventId
  z.number(), // [1] parentEventId
  z.string(), // [2] homeTeam
  z.string(), // [3] awayTeam
  z.number(), // [4] ???
  z.array(PeriodSchema), // [5] periods
  z.string(), // [6] ???
  z.array(z.unknown()), // [7] periodSummaries
]);

// League: exactly 4 elements [leagueId, leagueName, events[], unknownArray[]]
export const LeagueSchema = z.tuple([
  z.number(),
  z.string(),
  z.array(EventSchema),
  z.array(z.unknown()),
]);

// StatusGroup: exactly 2 elements [status, leagues[]]
export const StatusGroupSchema = z.tuple([z.string(), z.array(LeagueSchema)]);

// ============================================================
// Events List Response Schema
// ============================================================

// Sport: exactly 4 elements [sportId, sportName, isActive, statusGroups[]]
export const SportSchemaForEventsList = z.tuple([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(StatusGroupSchema),
]);

// Top-level response for events list
export const PinnacleEventsResponseSchema = z.object({
  code: z.number(),
  data: z.tuple([
    z.number(), // pageNo
    z.number(), // pageSize
    z.number(), // totalCount
    z.array(SportSchemaForEventsList), // sports
  ]),
  errorCode: z.string(),
  message: z.string(),
  success: z.boolean().optional(),
});

// ============================================================
// Single Event Markets Response Schema
// ============================================================

// Sport schema for single event endpoint (different structure)
export const SportSchemaForSingleEvent = z.tuple([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(LeagueSchema),
]);

// Top-level response for single event markets
export const PinnacleEventMarketsResponseSchema = z.object({
  code: z.number(),
  data: z.array(SportSchemaForSingleEvent),
  errorCode: z.string(),
  message: z.string(),
  success: z.boolean().optional(),
});

// ============================================================
// Type Exports
// ============================================================

export type PinnacleEventsResponse = z.infer<
  typeof PinnacleEventsResponseSchema
>;
export type PinnacleEventMarketsResponse = z.infer<
  typeof PinnacleEventMarketsResponseSchema
>;
export type PinnacleEvent = z.infer<typeof EventSchema>;
export type PinnaclePeriod = z.infer<typeof PeriodSchema>;
export type PinnacleMarket = z.infer<typeof MarketSchema>;
export type PinnacleOutcome = z.infer<typeof OutcomeSchema>;

// Legacy alias for backward compatibility
export const PinnacleResponseSchema = PinnacleEventsResponseSchema;
export type PinnacleResponse = PinnacleEventsResponse;
