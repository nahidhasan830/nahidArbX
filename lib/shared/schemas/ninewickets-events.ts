/**
 * NineWickets Event Schemas
 *
 * Zod schemas for NineWickets Exchange event/fixture responses.
 * Used by the NineWickets Exchange event adapter.
 */

import { z } from "zod";

export const NineWicketsEventSchema = z.object({
  eventId: z.number(),
  eventName: z.string(),
  competitionId: z.number(),
  competitionName: z.string(),
  openDateTime: z.number(), // timestamp in ms
  eventType: z.number(),
  status: z.number(),
  market: z.unknown().optional(),
});

export const NineWicketsEventsResponseSchema = z.object({
  events: z.array(NineWicketsEventSchema),
});

export type NineWicketsEvent = z.infer<typeof NineWicketsEventSchema>;
