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
    for (const entry of reg.entries.values()) {
      if (entry.disposed) continue;
      entry.disposed = true;
      entry.browser.close().catch(() => {
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
    }
  }
  reg.entries.set(key, { browser, disposed: false });
  browser.once("disconnected", () => {
    const now = getRegistry().entries.get(key);
    if (now && now.browser === browser) {
      getRegistry().entries.delete(key);
    }
  });
}

export function getSingletonBrowser(key: string): Browser | null {
  const entry = getRegistry().entries.get(key);
  if (!entry || entry.disposed) return null;
  if (!entry.browser.isConnected()) {
    getRegistry().entries.delete(key);
    return null;
  }
  return entry.browser;
}

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
  }
}

export function getRegisteredSingletonKeys(): string[] {
  return Array.from(getRegistry().entries.keys());
}
