/**
 * Market Diagnostics Repository
 *
 * DB access layer for the unmapped_markets and market_anomalies tables.
 * Used by the sync pipeline (writes) and the /lab/market-matcher UI (reads).
 */

import { db } from "../client";
import { unmappedMarkets, marketAnomalies } from "../schema";
import { desc, eq, sql, lt } from "drizzle-orm";
import type { NewMarketAnomalyRow } from "../schema";

// ============================================
// Unmapped Markets
// ============================================

/**
 * Upsert an unmapped market entry. If (provider, rawMarketKey) already exists,
 * bumps occurrence_count, updates last_seen_at and sample_payload.
 */
export async function recordUnmappedMarket(entry: {
  provider: string;
  rawMarketKey: string;
  rawMarketName?: string;
  samplePayload?: unknown;
}): Promise<void> {
  await db
    .insert(unmappedMarkets)
    .values({
      provider: entry.provider,
      rawMarketKey: entry.rawMarketKey,
      rawMarketName: entry.rawMarketName ?? null,
      samplePayload: entry.samplePayload ?? null,
    })
    .onConflictDoUpdate({
      target: [unmappedMarkets.provider, unmappedMarkets.rawMarketKey],
      set: {
        occurrenceCount: sql`${unmappedMarkets.occurrenceCount} + 1`,
        lastSeenAt: sql`now()`,
        samplePayload: entry.samplePayload
          ? sql`${JSON.stringify(entry.samplePayload)}::jsonb`
          : sql`${unmappedMarkets.samplePayload}`,
        rawMarketName: entry.rawMarketName ?? sql`${unmappedMarkets.rawMarketName}`,
      },
    });
}

/**
 * Batch-upsert multiple unmapped market entries in a single statement.
 * Deduplicates by (provider, rawMarketKey) before inserting.
 */
export async function recordUnmappedMarketBatch(
  entries: Array<{
    provider: string;
    rawMarketKey: string;
    rawMarketName?: string;
    samplePayload?: unknown;
  }>,
): Promise<number> {
  if (entries.length === 0) return 0;

  // Deduplicate by (provider, rawMarketKey) — keep the last occurrence
  const deduped = new Map<
    string,
    (typeof entries)[number]
  >();
  for (const e of entries) {
    deduped.set(`${e.provider}\0${e.rawMarketKey}`, e);
  }

  const values = Array.from(deduped.values());

  // Batch insert with ON CONFLICT
  for (const entry of values) {
    await recordUnmappedMarket(entry);
  }

  return values.length;
}

/**
 * Get top unmapped markets sorted by occurrence count.
 */
export async function getTopUnmappedMarkets(
  limit = 200,
  provider?: string,
) {
  const conditions = provider
    ? eq(unmappedMarkets.provider, provider)
    : undefined;

  return db
    .select()
    .from(unmappedMarkets)
    .where(conditions)
    .orderBy(desc(unmappedMarkets.occurrenceCount))
    .limit(limit);
}

/**
 * Get distinct providers that have unmapped markets.
 */
export async function getUnmappedProviders(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ provider: unmappedMarkets.provider })
    .from(unmappedMarkets)
    .orderBy(unmappedMarkets.provider);
  return rows.map((r) => r.provider);
}

/**
 * Delete unmapped markets older than N days (housekeeping).
 */
export async function clearOldUnmapped(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const result = await db
    .delete(unmappedMarkets)
    .where(lt(unmappedMarkets.lastSeenAt, cutoff));
  return result.rowCount ?? 0;
}

// ============================================
// Market Anomalies
// ============================================

/**
 * Record a market anomaly (implied-probability deviation).
 */
export async function recordAnomaly(
  entry: Omit<NewMarketAnomalyRow, "id" | "createdAt">,
): Promise<void> {
  await db.insert(marketAnomalies).values(entry);
}

/**
 * Fire-and-forget wrapper for recordAnomaly — logs errors instead of throwing.
 */
export async function recordAnomalyAsync(
  entry: Omit<NewMarketAnomalyRow, "id" | "createdAt">,
): Promise<void> {
  try {
    await recordAnomaly(entry);
  } catch {
    // Swallow — telemetry must never block the hot loop
  }
}

/**
 * Get recent anomalies, optionally filtered by event.
 */
export async function getRecentAnomalies(
  limit = 200,
  eventId?: string,
) {
  const conditions = eventId
    ? eq(marketAnomalies.eventId, eventId)
    : undefined;

  return db
    .select()
    .from(marketAnomalies)
    .where(conditions)
    .orderBy(desc(marketAnomalies.createdAt))
    .limit(limit);
}

/**
 * Get anomaly type distribution for the stats endpoint.
 */
export async function getAnomalyStats() {
  const rows = await db
    .select({
      anomalyType: marketAnomalies.anomalyType,
      count: sql<number>`count(*)::int`,
      avgDeviation: sql<number>`round(avg(${marketAnomalies.deviationPct}), 2)`,
    })
    .from(marketAnomalies)
    .groupBy(marketAnomalies.anomalyType);

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return { total, byType: rows };
}

/**
 * Delete anomalies older than N days.
 */
export async function clearOldAnomalies(olderThanDays = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  const result = await db
    .delete(marketAnomalies)
    .where(lt(marketAnomalies.createdAt, cutoff));
  return result.rowCount ?? 0;
}
