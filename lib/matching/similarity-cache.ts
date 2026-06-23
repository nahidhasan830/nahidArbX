
import { bestSim } from "./string-sim";

const MAX_CACHE_SIZE = 10_000;

const cache = new Map<string, number>();

export function cachedCompareTwoStrings(a: string, b: string): number {
  if (a === b) return 1;

  const key = a < b ? `${a}\0${b}` : `${b}\0${a}`;

  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const result = bestSim(a, b);

  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }

  cache.set(key, result);
  return result;
}

export function getSimilarityCacheStats() {
  return { size: cache.size, maxSize: MAX_CACHE_SIZE };
}

export function clearSimilarityCache() {
  cache.clear();
}
