/**
 * Model types for AI providers.
 */

export type ModelTier = "lite" | "flash" | "pro";
export type SearchEngine = "auto" | "vertex" | "brave" | "tavily";

export const DEFAULT_MODEL_TIER: ModelTier = "lite";
export const MODEL_TIERS: ModelTier[] = ["lite", "flash", "pro"];