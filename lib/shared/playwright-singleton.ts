/**
 * Hot-reload-safe registry for long-lived Playwright browser instances.
 *
 * Why this exists
 * ---------------
 * Every Playwright-backed session layer (9W session, 9W main-site CF
 * client, Pinnacle token manager) keeps a persistent Chromium alive as
 * a module-level variable. In Next.js dev mode every file save reloads
 * the module: the module-level reference resets to `null`, but the
 * Chromium OS process it was pointing at keeps running. After a few
 * dozen edits you end up with a hundred orphan Chromium processes
 * holding tens of GB of RAM — we've seen it push Cursor to 66 GB.
 *
 * The fix is to store browser references on `globalThis` under a
 * stable symbol. The globalThis object survives Hot-Module-Reload, so
 * the new module revision can find the previous instance and either
 * reuse it (no extra launch) or dispose it (no orphan) — the choice is
 * up to the caller.
 *
 * We also wire one process-exit handler (SIGINT/SIGTERM/beforeExit)
 * that tears down every registered browser so `npm run dev` → Ctrl-C
 * doesn't leave orphans either. The handler installs exactly once per
 * process via a separate global flag.
 */
import type { Browser } from "playwright";

interface RegistryEntry {
  browser: Browser;
  disposed: boolean;
}

interface Registry {
  entries: Map<string, RegistryEntry>;
  exitHooksInstalled: boolean;
}

const REGISTRY_KEY = Symbol.for("nahidarbx.playwright-singleton.registry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Registry;
};

function getRegistry(): Registry {
  const g = globalThis as GlobalWithRegistry;
  let reg = g[REGISTRY_KEY];
  if (!reg) {
    reg = { entries: new Map(), exitHooksInstalled: false };
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

function installExitHooksOnce(): void {
  const reg = getRegistry();
  if (reg.exitHooksInstalled) return;
  reg.exitHooksInstalled = true;
  const dispose = () => {
    // Fire-and-forget — we're exiting, best-effort is enough.
    for (const entry of reg.entries.values()) {
      if (entry.disposed) continue;
      entry.disposed = true;
      entry.browser.close().catch(() => {
        // process is exiting — nothing useful we can do with this error
      });
    }
  };
  process.once("beforeExit", dispose);
  process.once("SIGINT", () => {
    dispose();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    dispose();
    process.exit(143);
  });
}

/**
 * Register (or update) the current browser instance for `key`. If a
 * previous browser was registered under the same key (which happens
 * across HMR reloads) it is closed first so Chromium processes don't
 * accumulate.
 *
 * Callers should normally do:
 *
 *     const existing = getSingletonBrowser(KEY);
 *     if (existing && existing.isConnected()) return existing;
 *     const b = await chromium.launch(...);
 *     registerSingletonBrowser(KEY, b);
 */
export async function registerSingletonBrowser(
  key: string,
  browser: Browser,
): Promise<void> {
  installExitHooksOnce();
  const reg = getRegistry();
  const existing = reg.entries.get(key);
  if (existing && existing.browser !== browser && !existing.disposed) {
    existing.disposed = true;
    try {
      await existing.browser.close();
    } catch {
      // ignore — may already be dead from a crashed prior run
    }
  }
  reg.entries.set(key, { browser, disposed: false });
  // If Playwright drops the connection (crash, OOM) clear the entry so
  // the next caller re-launches instead of reusing a dead handle.
  browser.once("disconnected", () => {
    const now = getRegistry().entries.get(key);
    if (now && now.browser === browser) {
      getRegistry().entries.delete(key);
    }
  });
}

/**
 * Look up the currently-registered browser for `key`. Returns null if
 * none has been registered, or if the registered one has been
 * disposed/disconnected.
 */
export function getSingletonBrowser(key: string): Browser | null {
  const entry = getRegistry().entries.get(key);
  if (!entry || entry.disposed) return null;
  if (!entry.browser.isConnected()) {
    getRegistry().entries.delete(key);
    return null;
  }
  return entry.browser;
}

/**
 * Close and unregister the browser for `key`. Safe to call even when
 * no browser is registered — returns a resolved promise.
 */
export async function closeSingletonBrowser(key: string): Promise<void> {
  const reg = getRegistry();
  const entry = reg.entries.get(key);
  if (!entry) return;
  reg.entries.delete(key);
  if (entry.disposed) return;
  entry.disposed = true;
  try {
    await entry.browser.close();
  } catch {
    // ignore — browser may already be dead
  }
}

/**
 * Introspection helper — lets diagnostics endpoints report how many
 * Chromium instances are currently registered in-process.
 */
export function getRegisteredSingletonKeys(): string[] {
  return Array.from(getRegistry().entries.keys());
}
