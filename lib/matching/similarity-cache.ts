/**
 * LRU Cache for string similarity comparisons.
 *
 * `compareTwoStrings()` (Dice coefficient) is called for every event pair
 * during matching. The same team name pairs ("Manchester United" vs "Man Utd")
 * are compared fresh each sync cycle. This cache stores results keyed by
 * sorted string pairs, giving ~80% hit rate across syncs.
 *
 * Memory: ~100KB for 10K entries (two short strings + float per entry).
 */

import { compareTwoStrings } from "string-similarity";

const MAX_CACHE_SIZE = 10_000;

// Map<"str1\0str2", similarity> — keys are sorted so (a,b) and (b,a) share an entry
const cache = new Map<string, number>();

/**
 * Cached version of `compareTwoStrings` from string-similarity.
 * Dice coefficient is symmetric, so we sort the pair to deduplicate.
 */
export function cachedCompareTwoStrings(a: string, b: string): number {
  // Fast path: identical strings
  if (a === b) return 1;

  // Sort to normalize key (Dice coefficient is symmetric)
  const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;

  const cached = cache.get(key);
  if (cached !== undefined) {
    // Move to end for LRU behavior (Map iteration order = insertion order)
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const result = compareTwoStrings(a, b);

  // Evict oldest entry if at capacity
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }

  cache.set(key, result);
  return result;
}

/** Get cache stats for diagnostics. */
export function getSimilarityCacheStats() {
  return { size: cache.size, maxSize: MAX_CACHE_SIZE };
}

/** Clear cache (useful between test runs or major resets). */
export function clearSimilarityCache() {
  cache.clear();
}
