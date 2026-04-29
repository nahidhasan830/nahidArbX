/**
 * Unmapped Market Buffer
 *
 * Collects unmapped-market telemetry entries during a sync cycle, then
 * flushes them to the database in a single batch at cycle end.
 *
 * This avoids per-selection DB calls inside the mapping hot loop.
 * The buffer is global (singleton) so all adapters contribute to the
 * same batch.
 */

import { singleton } from "@/lib/util/singleton";
import { recordUnmappedMarketBatch } from "@/lib/db/repositories/market-diagnostics";
import { logger } from "@/lib/shared/logger";
import type { ProviderKey } from "@/lib/providers/registry";

// ============================================
// Types
// ============================================

export interface UnmappedEntry {
  provider: ProviderKey;
  rawMarketKey: string;
  rawMarketName: string;
  samplePayload: unknown;
}

// ============================================
// Buffer (HMR-safe singleton)
// ============================================

const buffer = singleton(
  "atoms:unmappedBuffer",
  (): UnmappedEntry[] => [],
);

// ============================================
// Public API
// ============================================

/**
 * Add an unmapped market to the buffer. Called from mapping functions
 * when a provider market/selection can't be resolved to an atom.
 *
 * Cheap — just pushes to an in-memory array.
 */
export function bufferUnmappedMarket(entry: UnmappedEntry): void {
  // Cap buffer size to prevent unbounded growth in pathological cases
  if (buffer.length < 5000) {
    buffer.push(entry);
  }
}

/**
 * Flush all buffered entries to the database and clear the buffer.
 * Call once at the end of each odds sync cycle.
 *
 * Returns the number of entries flushed.
 */
export async function flushUnmappedBuffer(): Promise<number> {
  if (buffer.length === 0) return 0;

  // Snapshot and clear immediately so the next cycle can start accumulating
  const snapshot = buffer.splice(0, buffer.length);

  try {
    return await recordUnmappedMarketBatch(snapshot);
  } catch (err) {
    logger.warn(
      "UnmappedBuffer",
      `Failed to flush ${snapshot.length} entries: ${(err as Error).message}`,
    );
    return 0;
  }
}

/**
 * Get the current buffer size (for diagnostics).
 */
export function getUnmappedBufferSize(): number {
  return buffer.length;
}
