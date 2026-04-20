/**
 * Shared NineWickets Zod Schemas
 *
 * Common validation schemas for NineWickets Exchange and Sportsbook APIs.
 */

import { z } from "zod";

// ============================================
// Exchange Market Schemas
// ============================================

export const PriceSchema = z.object({
  price: z.number(),
  size: z.number(),
});

export const SelectionSchema = z.object({
  selectionId: z.number(),
  runnerName: z.string(),
  sortPriority: z.number(),
  status: z.number(),
  availableToBack: z.array(PriceSchema).optional(),
  availableToLay: z.array(PriceSchema).optional(),
});

export const MarketSchema = z.object({
  eventId: z.number(),
  marketId: z.string(),
  marketType: z.string(),
  marketName: z.string(),
  status: z.number(),
  selections: z.array(SelectionSchema).optional(),
});

export const MarketsResponseSchema = z.object({
  markets: z.array(MarketSchema),
});

// ============================================
// Type Exports
// ============================================

export type Price = z.infer<typeof PriceSchema>;
export type Selection = z.infer<typeof SelectionSchema>;
export type Market = z.infer<typeof MarketSchema>;
export type MarketsResponse = z.infer<typeof MarketsResponseSchema>;
