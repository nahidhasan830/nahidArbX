
import { z } from "zod";

export const SOCCER_SPORT_ID = 29;


export const OutcomeSchema = z.tuple([
  z.number().nullable(),
  z.number().nullable(),
  z.string(),
  z.string(),
  z.number().nullable(),
]);

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

export const PeriodSchema = z.tuple([
  z.number(),
  z.number(),
  z.string(),
  z.string(),
  z.boolean(),
  z.array(MarketSchema),
  z.number(),
]);

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

export const LeagueSchema = z.tuple([
  z.number(),
  z.string(),
  z.array(EventSchema),
  z.array(z.unknown()).nullable(),
]);

export const StatusGroupSchema = z.tuple([z.string(), z.array(LeagueSchema)]);


export const SportSchemaForEventsList = z.tuple([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(StatusGroupSchema),
]);

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


export const SportSchemaForSingleEvent = z.tuple([
  z.number(),
  z.string(),
  z.boolean(),
  z.array(LeagueSchema),
]);

export const PinnacleEventMarketsResponseSchema = z.object({
  code: z.number(),
  data: z.array(SportSchemaForSingleEvent),
  errorCode: z.string(),
  message: z.string(),
  success: z.boolean().optional(),
});


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

export const PinnacleResponseSchema = PinnacleEventsResponseSchema;
export type PinnacleResponse = PinnacleEventsResponse;
