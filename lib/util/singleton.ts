export function singleton<T>(key: string, init: () => T): T {
  const slot = `__nahidArbX_${key}__`;
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  if (g[slot] === undefined) g[slot] = init();
  return g[slot] as T;
}
