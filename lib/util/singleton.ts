/**
 * Module-scoped singleton that survives Next.js HMR and module-context
 * duplication. Under Turbopack, `instrumentation.ts` and route handlers
 * live in separate module graphs: a module-level `let x = ...` in each
 * gives two independent values. Pinning state to `globalThis` forces
 * every loader to reuse the same instance.
 *
 * No ESLint/TS ceremony: no `declare global`, no `var`, no `any`.
 */
export function singleton<T>(key: string, init: () => T): T {
  const slot = `__nahidArbX_${key}__`;
  const g = globalThis as typeof globalThis & Record<string, unknown>;
  if (g[slot] === undefined) g[slot] = init();
  return g[slot] as T;
}
