/**
 * IPRoyal residential proxy pool — SofaScore fallback only.
 *
 * SofaScore sits behind Cloudflare. Cloud Run egress IPs are well-known
 * datacenter ranges and periodically get 403'd when the adaptive bot
 * score trips. The fix is to route through residential IPs on failure.
 *
 * This module:
 *   - Loads proxy credentials from sessions/iproyal/proxies.txt (gitignored).
 *     Each line is `host:port:user:pass` with a sticky session id embedded
 *     in the password (lifetime-168h → 7-day sticky IP per session).
 *   - Exposes `getProxyAgent()` which returns a sticky current proxy.
 *   - Tracks per-proxy 403 cooldowns so a bad IP rotates out automatically.
 *   - Tracks a global "direct on cooldown" flag so after a direct 403 we
 *     skip straight to proxy for a short window instead of re-tripping
 *     Cloudflare every tick.
 *
 * Not a general-purpose HTTP client — intentionally scoped to SofaScore.
 */

import fs from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { singleton } from "../../util/singleton";
import { logger } from "../../shared/logger";

interface ProxyEntry {
  host: string;
  port: number;
  username: string;
  password: string;
  label: string;
  cooldownUntil: number;
}

interface ProxyPool {
  entries: ProxyEntry[];
  currentIdx: number;
  lastDirect403At: number;
}

// Per-proxy cooldown once it 403s. 30 min lets Cloudflare's adaptive
// bot-score on that IP decay before we reuse it.
const PROXY_COOLDOWN_MS = 30 * 60 * 1000;

// After a direct 403, skip direct entirely for this window and route
// via proxy. Prevents the "re-trip Cloudflare every 10-min tick" loop
// that used to leave bets stuck for hours.
const DIRECT_COOLDOWN_MS = 10 * 60 * 1000;

const PROXY_FILE_PATH = path.resolve(
  process.cwd(),
  "sessions/iproyal/proxies.txt",
);

function loadState(): ProxyPool {
  if (!fs.existsSync(PROXY_FILE_PATH)) {
    logger.warn(
      "IPRoyalProxy",
      `Proxy file not found at ${PROXY_FILE_PATH} — SofaScore fallback disabled.`,
    );
    return { entries: [], currentIdx: 0, lastDirect403At: 0 };
  }
  const lines = fs
    .readFileSync(PROXY_FILE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  const entries: ProxyEntry[] = [];
  for (const line of lines) {
    // IPRoyal format: host:port:user:pass — the password itself has no
    // colons (only underscores + dashes) so a 4-way split is safe.
    const parts = line.split(":");
    if (parts.length !== 4) continue;
    const [host, portStr, user, pass] = parts;
    const port = Number(portStr);
    if (!Number.isFinite(port)) continue;
    const sessionMatch = pass.match(/session-([^_]+)/);
    const label = sessionMatch ? sessionMatch[1] : `idx${entries.length}`;
    entries.push({
      host,
      port,
      username: user,
      password: pass,
      label,
      cooldownUntil: 0,
    });
  }
  // Randomize starting index so concurrent Cloud Run instances don't
  // all hammer the same proxy.
  const currentIdx =
    entries.length > 0 ? Math.floor(Math.random() * entries.length) : 0;
  logger.info(
    "IPRoyalProxy",
    `Loaded ${entries.length} proxies (starting at idx ${currentIdx})`,
  );
  return { entries, currentIdx, lastDirect403At: 0 };
}

const pool = singleton<ProxyPool>("settle:iproyal-proxy", loadState);

const buildProxyUrl = (entry: ProxyEntry): string =>
  `http://${encodeURIComponent(entry.username)}:${encodeURIComponent(
    entry.password,
  )}@${entry.host}:${entry.port}`;

/**
 * Returns an https-proxy-agent for the current sticky proxy, plus its
 * label for logging/cooldown tracking. Null if no proxies are loaded.
 *
 * Sticks to `currentIdx` until it's reported as 403'd, then rotates.
 * If every proxy is on cooldown, uses the one with the earliest
 * expiry anyway — better to try a likely-still-cool proxy than to
 * give up entirely.
 */
export function getProxyAgent(): {
  agent: HttpsProxyAgent<string>;
  label: string;
} | null {
  if (pool.entries.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < pool.entries.length; i++) {
    const idx = (pool.currentIdx + i) % pool.entries.length;
    const entry = pool.entries[idx];
    if (entry.cooldownUntil > now) continue;
    pool.currentIdx = idx;
    return {
      agent: new HttpsProxyAgent(buildProxyUrl(entry)),
      label: entry.label,
    };
  }
  // All on cooldown — pick the one whose cooldown expires soonest.
  let earliest = pool.entries[0];
  for (const e of pool.entries) {
    if (e.cooldownUntil < earliest.cooldownUntil) earliest = e;
  }
  logger.warn(
    "IPRoyalProxy",
    `All ${pool.entries.length} proxies on cooldown — reusing ${earliest.label} (${Math.round((earliest.cooldownUntil - now) / 60000)}m left).`,
  );
  return {
    agent: new HttpsProxyAgent(buildProxyUrl(earliest)),
    label: earliest.label,
  };
}

export function reportProxy403(label: string): void {
  const entry = pool.entries.find((e) => e.label === label);
  if (!entry) return;
  entry.cooldownUntil = Date.now() + PROXY_COOLDOWN_MS;
  pool.currentIdx = (pool.currentIdx + 1) % pool.entries.length;
  logger.warn(
    "IPRoyalProxy",
    `Proxy ${label} got 403 — cooldown ${PROXY_COOLDOWN_MS / 60000}min, rotating to next.`,
  );
}

export function reportDirect403(): void {
  pool.lastDirect403At = Date.now();
}

export function isDirectOnCooldown(): boolean {
  if (pool.lastDirect403At === 0) return false;
  return Date.now() - pool.lastDirect403At < DIRECT_COOLDOWN_MS;
}

export interface ProxyPoolStats {
  total: number;
  onCooldown: number;
  directOnCooldown: boolean;
  directCooldownRemainingMs: number;
}

export function getProxyStats(): ProxyPoolStats {
  const now = Date.now();
  const onCooldown = pool.entries.filter((e) => e.cooldownUntil > now).length;
  const remaining =
    pool.lastDirect403At === 0
      ? 0
      : Math.max(0, DIRECT_COOLDOWN_MS - (now - pool.lastDirect403At));
  return {
    total: pool.entries.length,
    onCooldown,
    directOnCooldown: remaining > 0,
    directCooldownRemainingMs: remaining,
  };
}
