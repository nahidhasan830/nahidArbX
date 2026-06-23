
import { db } from "@/lib/db/client";
import { aiProviderConfig } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/shared/logger";

const tag = "AiProviderRepo";


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
  name: string;

  enabled: boolean;
  disabledReason: string | null;

  modelId: string | null;
  tier: ProviderTier | null;
  label: string;
  tagline: string | null;
  engineType: EngineType;

  totalUsageCount: number;
  monthlyUsageCount: number;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  isExhausted: boolean;
  hasMonthlyLimit: boolean;
  lastResetAt: string;
}


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
  {
    name: "deepseek-flash",
    enabled: true,
    modelId: "deepseek-v4-flash",
    tier: "flash",
    label: "DeepSeek Flash",
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
  {
    name: "vertex",
    enabled: true,
    modelId: "vertex-ai-search",
    tier: "flash",
    label: "Vertex AI Search",
    tagline: "Google's enterprise search",
    engineType: "search",
    monthlyLimit: null,
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


export async function getAllProviders(): Promise<AiProvider[]> {
  const rows = await db.select().from(aiProviderConfig);
  return rows.map(mapRowToProvider).sort(compareProviders);
}

export async function getLLMProviders(): Promise<AiProvider[]> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.engineType} = 'llm'`);
  return rows.map(mapRowToProvider).sort(compareProviders);
}

export async function getSearchProviders(): Promise<AiProvider[]> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.engineType} = 'search'`);
  return rows.map(mapRowToProvider).sort(compareProviders);
}

export async function getProviderByName(
  name: string,
): Promise<AiProvider | null> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.name} = ${name}`)
    .limit(1);
  return rows[0] ? mapRowToProvider(rows[0]) : null;
}

export async function getProviderConfigs(): Promise<
  Record<string, { enabled: boolean; disabledReason: string | null }>
> {
  const rows = await db.select().from(aiProviderConfig);
  const map: Record<
    string,
    { enabled: boolean; disabledReason: string | null }
  > = {};
  for (const r of rows) {
    map[r.name] = { enabled: r.enabled, disabledReason: r.disabledReason };
  }
  return map;
}

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
      disabledReason: enabled ? null : (reason ?? "manual"),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: aiProviderConfig.name,
      set: {
        enabled,
        disabledReason: enabled ? null : (reason ?? "manual"),
        updatedAt: sql`now()`,
      },
    });
}

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
  const monthlyLimit = effectiveMonthlyLimit(row.name, row.monthlyLimit);
  const hasMonthlyLimit = monthlyLimit !== null;
  const monthlyRemaining = hasMonthlyLimit
    ? Math.max(0, monthlyLimit - row.monthlyUsageCount)
    : null;

  return {
    totalUsageCount: row.totalUsageCount,
    monthlyUsageCount: row.monthlyUsageCount,
    monthlyLimit,
    monthlyRemaining,
    isExhausted: hasMonthlyLimit && row.monthlyUsageCount >= monthlyLimit,
    hasMonthlyLimit,
  };
}

export async function hasQuota(provider: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(aiProviderConfig)
    .where(sql`${aiProviderConfig.name} = ${provider}`)
    .limit(1);

  if (rows.length === 0) return false;

  const r = rows[0];
  if (!r.enabled) return false;

  if (isUnlimitedProvider(r.name)) return true;

  if (r.monthlyLimit !== null && r.monthlyUsageCount >= r.monthlyLimit) {
    return false;
  }

  return true;
}

export async function incrementUsage(
  provider: string,
): Promise<{ totalUsageCount: number; monthlyUsageCount: number } | null> {
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

export async function getAllQuotas(): Promise<AiProvider[]> {
  return getAllProviders();
}


function mapRowToProvider(row: AiProviderRow): AiProvider {
  const monthlyLimit = effectiveMonthlyLimit(row.name, row.monthlyLimit);
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
    monthlyLimit,
    monthlyRemaining,
    isExhausted: hasMonthlyLimit && row.monthlyUsageCount >= monthlyLimit,
    hasMonthlyLimit,
    lastResetAt: row.lastResetAt,
  };
}

function isUnlimitedProvider(name: string): boolean {
  return name === "vertex";
}

function effectiveMonthlyLimit(
  name: string,
  monthlyLimit: number | null,
): number | null {
  return isUnlimitedProvider(name) ? null : monthlyLimit;
}

function compareProviders(a: AiProvider, b: AiProvider): number {
  const order: Record<string, number> = {
    vertex: 0,
    brave: 1,
    tavily: 2,
    "deepseek-flash": 10,
    "deepseek-pro": 11,
    "gemini-lite": 20,
    "gemini-flash": 21,
    "gemini-pro": 22,
  };
  return (order[a.name] ?? 99) - (order[b.name] ?? 99);
}
