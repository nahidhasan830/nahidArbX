/**
 * Repository for ai_provider_config table — unified provider config + quota tracking.
 *
 * Replaces the old ai_engine_config and ai_provider_quotas tables.
 */

import { db } from "@/lib/db/client";
import { aiProviderConfig } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";

const tag = "AiProviderRepo";

// ── Types ────────────────────────────────────────────────────────────────

export type ProviderTier = "lite" | "flash" | "pro";
export type EngineType = "llm" | "search";

export interface AiProviderRow {
  name: string;
  enabled: boolean;
  disabledReason: string | null;
  modelId: string | null;
  tier: string | null;
  label: string | null;
  tagline: string | null;
  engineType: string | null;
  totalUsageCount: number;
  monthlyUsageCount: number;
  monthlyLimit: number | null;
  lastResetAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiProvider {
  // Identity
  name: string;

  // Enabled/disabled
  enabled: boolean;
  disabledReason: string | null;

  // Model metadata
  modelId: string | null;
  tier: ProviderTier | null;
  label: string;
  tagline: string | null;
  engineType: EngineType;

  // Quota tracking
  totalUsageCount: number;
  monthlyUsageCount: number;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  isExhausted: boolean;
  hasMonthlyLimit: boolean;
  lastResetAt: string;
}

// ── Default providers to seed ────────────────────────────────────────

const DEFAULT_PROVIDERS: Array<{
  name: string;
  enabled: boolean;
  disabledReason?: string;
  modelId: string;
  tier: ProviderTier;
  label: string;
  tagline: string;
  engineType: EngineType;
  monthlyLimit: number | null;
}> = [
  // DeepSeek LLM providers
  {
    name: "deepseek-lite",
    enabled: true,
    modelId: "deepseek-v4-flash",
    tier: "lite",
    label: "DeepSeek Lite",
    tagline: "Fast, cheap — default for most calls",
    engineType: "llm",
    monthlyLimit: null,
  },
  {
    name: "deepseek-pro",
    enabled: true,
    modelId: "deepseek-v4-pro",
    tier: "pro",
    label: "DeepSeek Pro",
    tagline: "Deep reasoning",
    engineType: "llm",
    monthlyLimit: null,
  },
  // Gemini LLM providers
  {
    name: "gemini-lite",
    enabled: false,
    disabledReason: "not-configured",
    modelId: "gemini-3.1-flash-lite",
    tier: "lite",
    label: "Gemini Flash-Lite",
    tagline: "Cheapest",
    engineType: "llm",
    monthlyLimit: null,
  },
  {
    name: "gemini-flash",
    enabled: false,
    disabledReason: "not-configured",
    modelId: "gemini-3-flash",
    tier: "flash",
    label: "Gemini Flash",
    tagline: "Balanced",
    engineType: "llm",
    monthlyLimit: null,
  },
  {
    name: "gemini-pro",
    enabled: false,
    disabledReason: "not-configured",
    modelId: "gemini-3.1-pro",
    tier: "pro",
    label: "Gemini Pro",
    tagline: "Expert",
    engineType: "llm",
    monthlyLimit: null,
  },
  // Search providers with monthly limits
  {
    name: "vertex",
    enabled: true,
    modelId: "vertex-ai-search",
    tier: "flash",
    label: "Vertex AI Search",
    tagline: "Google's enterprise search",
    engineType: "search",
    monthlyLimit: 1000,
  },
  {
    name: "brave",
    enabled: true,
    modelId: "brave-search-api",
    tier: "flash",
    label: "Brave Search",
    tagline: "Privacy-first search",
    engineType: "search",
    monthlyLimit: 1000,
  },
  {
    name: "tavily",
    enabled: true,
    modelId: "tavily-api",
    tier: "flash",
    label: "Tavily",
    tagline: "AI-focused search",
    engineType: "search",
    monthlyLimit: 1000,
  },
];

// ── Core functions ─────────────────────────────────────────────────

/**
 * Get all AI providers.
 */
export async function getAllProviders(): Promise<AiProvider[]> {
  const rows = await db.select().from(aiProviderConfig);
  return rows.map(mapRowToProvider);
}

/**
 * Get only LLM providers.
 */
export async function getLLMProviders(): Promise<AiProvider[]> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.engineType} = 'llm'`);
  return rows.map(mapRowToProvider);
}

/**
 * Get only search providers.
 */
export async function getSearchProviders(): Promise<AiProvider[]> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.engineType} = 'search'`);
  return rows.map(mapRowToProvider);
}

/**
 * Get a single provider by name.
 */
export async function getProviderByName(name: string): Promise<AiProvider | null> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.name} = ${name}`)
    .limit(1);
  return rows[0] ? mapRowToProvider(rows[0]) : null;
}

/**
 * Get provider config map (name → {enabled, disabledReason}).
 */
export async function getProviderConfigs(): Promise<
  Record<string, { enabled: boolean; disabledReason: string | null }>
> {
  const rows = await db.select().from(aiProviderConfig);
  const map: Record<string, { enabled: boolean; disabledReason: string | null }> = {};
  for (const r of rows) {
    map[r.name] = { enabled: r.enabled, disabledReason: r.disabledReason };
  }
  return map;
}

/**
 * Set provider enabled/disabled state.
 */
export async function setProviderEnabled(
  name: string,
  enabled: boolean,
  reason?: string,
): Promise<void> {
  await db
    .insert(aiProviderConfig)
    .values({
      name,
      enabled,
      disabledReason: enabled ? null : reason ?? "manual",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: aiProviderConfig.name,
      set: {
        enabled,
        disabledReason: enabled ? null : reason ?? "manual",
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Seed default providers if table is empty.
 */
export async function seedProvidersIfEmpty(): Promise<void> {
  const existing = await db
    .select({ name: aiProviderConfig.name })
    .from(aiProviderConfig)
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  await db.insert(aiProviderConfig).values(
    DEFAULT_PROVIDERS.map((p) => ({
      name: p.name,
      enabled: p.enabled,
      disabledReason: p.disabledReason ?? null,
      modelId: p.modelId,
      tier: p.tier,
      label: p.label,
      tagline: p.tagline,
      engineType: p.engineType,
      totalUsageCount: 0,
      monthlyUsageCount: 0,
      monthlyLimit: p.monthlyLimit,
      lastResetAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  );

  logger.info(tag, `Seeded ${DEFAULT_PROVIDERS.length} providers`);
}

// ── Quota functions ───────────��────────────────────────────────────

/**
 * Get quota status for a provider.
 */
export async function getQuota(provider: string): Promise<{
  totalUsageCount: number;
  monthlyUsageCount: number;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  isExhausted: boolean;
  hasMonthlyLimit: boolean;
} | null> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.name} = ${provider}`)
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];
  const monthlyLimit = row.monthlyLimit;
  const hasMonthlyLimit = monthlyLimit !== null;
  const monthlyRemaining = hasMonthlyLimit
    ? Math.max(0, monthlyLimit - row.monthlyUsageCount)
    : null;

  return {
    totalUsageCount: row.totalUsageCount,
    monthlyUsageCount: row.monthlyUsageCount,
    monthlyLimit: row.monthlyLimit,
    monthlyRemaining,
    isExhausted: hasMonthlyLimit && row.monthlyUsageCount >= monthlyLimit,
    hasMonthlyLimit,
  };
}

/**
 * Check if provider has quota available.
 * Returns false if exhausted or disabled.
 */
export async function hasQuota(provider: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.name} = ${provider}`)
    .limit(1);

  if (rows.length === 0) return false;

  const r = rows[0];
  if (!r.enabled) return false;

  // Check monthly limit
  if (r.monthlyLimit !== null && r.monthlyUsageCount >= r.monthlyLimit) {
    return false;
  }

  return true;
}

/**
 * Increment usage count for a provider.
 * Returns new counts, or null if quota exhausted (auto-disables search provider).
 */
export async function incrementUsage(
  provider: string,
): Promise<{ totalUsageCount: number; monthlyUsageCount: number } | null> {
  // First check current quota
  const quota = await getQuota(provider);
  if (quota && quota.hasMonthlyLimit && quota.isExhausted) {
    logger.warn(tag, `${provider} quota exhausted, rejecting`);
    return null;
  }

  const now = new Date().toISOString();

  const result = await db
    .update(aiProviderConfig)
    .set({
      totalUsageCount: sql`${aiProviderConfig.totalUsageCount} + 1`,
      monthlyUsageCount: sql`${aiProviderConfig.monthlyUsageCount} + 1`,
      updatedAt: now,
    })
    .where(sql`${aiProviderConfig.name} = ${provider}`)
    .returning({
      totalUsageCount: aiProviderConfig.totalUsageCount,
      monthlyUsageCount: aiProviderConfig.monthlyUsageCount,
    });

  if (result.length === 0) {
    logger.error(tag, `Failed to increment quota for ${provider}`);
    return null;
  }

  // Check if quota exhausted after increment (for search providers)
  const updatedQuota = await getQuota(provider);
  if (updatedQuota?.hasMonthlyLimit && updatedQuota.isExhausted) {
    await setProviderEnabled(provider, false, "quota-exhausted");
    logger.warn(tag, `Auto-disabled ${provider} (quota exhausted)`);
  }

  return {
    totalUsageCount: result[0].totalUsageCount,
    monthlyUsageCount: result[0].monthlyUsageCount,
  };
}

/**
 * Reset monthly usage for all providers (called by scheduler).
 */
export async function resetMonthlyUsage(): Promise<number> {
  const now = new Date().toISOString();

  const result = await db
    .update(aiProviderConfig)
    .set({
      monthlyUsageCount: 0,
      lastResetAt: now,
      updatedAt: now,
    })
    .returning({ name: aiProviderConfig.name });

  logger.info(tag, `Reset monthly usage for ${result.length} providers`);
  return result.length;
}

/**
 * Get all provider quotas for dashboard display.
 */
export async function getAllQuotas(): Promise<AiProvider[]> {
  return getAllProviders();
}

// ── Helpers ─────────────────────────────────────────────────────────

function mapRowToProvider(row: AiProviderRow): AiProvider {
  const monthlyLimit = row.monthlyLimit;
  const hasMonthlyLimit = monthlyLimit !== null;
  const monthlyRemaining = hasMonthlyLimit
    ? Math.max(0, monthlyLimit - row.monthlyUsageCount)
    : null;

  return {
    name: row.name,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    modelId: row.modelId,
    tier: (row.tier as ProviderTier) ?? null,
    label: row.label ?? row.name,
    tagline: row.tagline,
    engineType: (row.engineType as EngineType) ?? "llm",
    totalUsageCount: row.totalUsageCount,
    monthlyUsageCount: row.monthlyUsageCount,
    monthlyLimit: row.monthlyLimit,
    monthlyRemaining,
    isExhausted: hasMonthlyLimit && row.monthlyUsageCount >= monthlyLimit,
    hasMonthlyLimit,
    lastResetAt: row.lastResetAt,
  };
}