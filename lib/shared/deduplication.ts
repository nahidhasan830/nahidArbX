/**
 * Deduplication Utilities
 *
 * Generic functions for deduplicating arrays of objects.
 */

/**
 * Deduplicates an array of objects by their `id` property.
 * Later items overwrite earlier ones if they have the same id.
 */
export function deduplicateById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return Array.from(map.values());
}

/**
 * Deduplicates an array of objects by a custom key function.
 * Later items overwrite earlier ones if they have the same key.
 */
export function deduplicateBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return Array.from(map.values());
}
