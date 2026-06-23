
import { z } from "zod";


export const BCEventSchema = z.object({
  id: z.number(),
  type_1: z.string(),
  price: z.number(),
  name: z.string(),
  base: z.number().optional(),
  order: z.number().optional(),
});

export type BCEventParsed = z.infer<typeof BCEventSchema>;


export const BCMarketSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  base: z.number().optional(),
  display_key: z.string().optional(),
  express_id: z.number().optional(),
  event: z.record(z.string(), BCEventSchema).optional(),
});

export type BCMarketParsed = z.infer<typeof BCMarketSchema>;


export const BCGameInfoSchema = z.object({
  current_game_state: z.string().optional(),
  current_game_time: z.string().optional(),
  score1: z.string().optional(),
  score2: z.string().optional(),
  add_minutes: z.string().optional(),
});

export type BCGameInfoParsed = z.infer<typeof BCGameInfoSchema>;


export const BCStatValueSchema = z.object({
  team1_value: z.number().nullable(),
  team2_value: z.number().nullable(),
});

export const BCStatsSchema = z.record(z.string(), BCStatValueSchema);

export type BCStatsParsed = z.infer<typeof BCStatsSchema>;


export const BCGameSchema = z.object({
  id: z.number(),
  team1_name: z.string(),
  team2_name: z.string().optional(),
  team1_id: z.number().optional(),
  team2_id: z.number().optional(),
  start_ts: z.number(),
  markets_count: z.number().optional(),
  is_blocked: z.number().optional().default(0),
  type: z.number().optional().default(0), // 0=prematch, 1=live, 2=scheduled
  info: BCGameInfoSchema.optional(),
  stats: BCStatsSchema.optional(),
  market: z.record(z.string(), BCMarketSchema).optional(),
});

export type BCGameParsed = z.infer<typeof BCGameSchema>;


export const BCResponseSchema = z.object({
  code: z.number(),
  rid: z.string(),
  data: z.object({
    subid: z.string().optional(),
    data: z.unknown(),
  }),
});

export type BCResponseParsed = z.infer<typeof BCResponseSchema>;


export const BCSessionResponseSchema = z.object({
  code: z.number(),
  rid: z.string(),
  data: z.object({
    sid: z.string(),
    version: z.string().optional(),
  }),
});

export type BCSessionResponseParsed = z.infer<typeof BCSessionResponseSchema>;
