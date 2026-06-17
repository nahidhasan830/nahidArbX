/**
 * SofaScore transport — curl_cffi direct, Scrape.do fallback on 403.
 *
 * SofaScore's API is blocked by Cloudflare's TLS fingerprint detection
 * (JA3/JA4 check rejects non-browser clients like Node.js's undici/OpenSSL).
 *
 * This module uses Python's `curl_cffi` library to impersonate Chrome's
 * TLS fingerprint. curl_cffi uses a modified libcurl (curl-impersonate)
 * compiled with BoringSSL and Chrome's cipher suite, producing a JA3
 * fingerprint identical to real Chrome.
 *
 * Architecture:
 *   - Each direct `fetchViaBrowser()` call spawns `python3 -c` with an inline script
 *   - The Python process makes a single HTTP GET with `impersonate="chrome120"`
 *   - Response JSON is piped back via stdout
 *   - If SofaScore returns a Cloudflare 403 challenge, retry that request
 *     through Scrape.do and briefly skip direct attempts on later calls
 *   - No persistent process, no browser, no memory leak
 *
 * Cost: $0 direct; Scrape.do credits only after direct 403.
 * Memory: ~15MB per request (Python process, immediately freed).
 * Latency: ~300-500ms per request (Python startup + HTTP).
 *
 * Prerequisite: `pip3 install curl_cffi` (one-time, already installed).
 */

import { execFile } from "node:child_process";
import { singleton } from "../../util/singleton";
import { logger } from "../../shared/logger";
import {
  fetchViaScrapeDoProxy,
  getProxyStats,
  isDirectOnCooldown,
  reportDirect403,
} from "./scrapedo-proxy";

const LOG_TAG = "SofaScoreCurl";
export const SOFASCORE_BROWSER_MAX_BUFFER_BYTES = 60 * 1024 * 1024;

// ─── Singleton State ─────────────────────────────────────────────────────────

interface TransportState {
  lastUsedAt: number;
  requestCount: number;
  directRequestCount: number;
  proxyRequestCount: number;
  consecutiveFailures: number;
}

const state = singleton<TransportState>("settle:sofascore-curl", () => ({
  lastUsedAt: 0,
  requestCount: 0,
  directRequestCount: 0,
  proxyRequestCount: 0,
  consecutiveFailures: 0,
}));

// ─── Python inline script ────────────────────────────────────────────────────

/**
 * Minimal Python script that fetches a URL with Chrome TLS impersonation.
 * Receives the URL as sys.argv[1], outputs JSON to stdout.
 * Exit code 0 = success, non-zero = failure.
 */
const PYTHON_FETCH_SCRIPT = `
import sys, json
from curl_cffi import requests
try:
    url = sys.argv[1]
    r = requests.get(url, impersonate="chrome120", timeout=20)
    if r.status_code != 200:
        print(json.dumps({"__error": True, "status": r.status_code}))
    else:
        # Pass through raw JSON text to avoid re-encoding
        sys.stdout.write(r.text)
except Exception as e:
    print(json.dumps({"__error": True, "message": str(e)}))
`;

// ─── Core fetch function ─────────────────────────────────────────────────────

function execPython(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "python3",
      ["-c", PYTHON_FETCH_SCRIPT, url],
      {
        timeout: 25_000, // 25s hard kill
        maxBuffer: SOFASCORE_BROWSER_MAX_BUFFER_BYTES,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
      (err, stdout, stderr) => {
        if (err) {
          // Include stderr for diagnostics (import errors, etc.)
          const msg = stderr?.trim()
            ? `${err.message} | stderr: ${stderr.trim().slice(0, 200)}`
            : err.message;
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );
    // Ensure child doesn't become zombie
    child.unref?.();
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

const SOFASCORE_API_BASE = "https://api.sofascore.com";

/**
 * Fetch a SofaScore API path via Python curl_cffi.
 *
 * @param apiPath — relative path, e.g. "/api/v1/sport/football/scheduled-events/2026-05-08"
 * @returns parsed JSON or null on failure
 */
export async function fetchViaBrowser<T>(apiPath: string): Promise<T | null> {
  const url = `${SOFASCORE_API_BASE}${apiPath}`;
  state.requestCount++;

  if (isDirectOnCooldown()) {
    return fetchViaProxy<T>(url, apiPath, "direct cooldown active");
  }

  try {
    state.directRequestCount++;
    const raw = await execPython(url);
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "__error" in parsed) {
      const errResult = parsed as { status?: number; message?: string };
      logger.warn(
        LOG_TAG,
        `API call failed: ${apiPath} → ${errResult.status ?? errResult.message}`,
      );
      if (errResult.status === 403) {
        reportDirect403();
        return fetchViaProxy<T>(url, apiPath, "direct 403 challenge");
      }
      markFailure();
      return null;
    }

    markSuccess();
    return parsed as T;
  } catch (err) {
    markFailure();
    logger.warn(
      LOG_TAG,
      `Fetch failed for ${apiPath}: ${(err as Error).message.slice(0, 200)}`,
    );
    return null;
  }
}

function markSuccess(): void {
  state.consecutiveFailures = 0;
  state.lastUsedAt = Date.now();
}

function markFailure(): void {
  state.consecutiveFailures++;
}

async function fetchViaProxy<T>(
  url: string,
  apiPath: string,
  reason: string,
): Promise<T | null> {
  state.proxyRequestCount++;
  logger.info(LOG_TAG, `Routing ${apiPath} through Scrape.do (${reason}).`);

  const proxied = await fetchViaScrapeDoProxy<T>(url);
  if (proxied && !isSofaScoreError(proxied)) {
    markSuccess();
    return proxied;
  }

  markFailure();
  return null;
}

function isSofaScoreError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { error?: { code?: number; reason?: string } };
  return typeof maybe.error?.code === "number";
}

/**
 * Check if the transport is healthy (curl_cffi working).
 * Returns false if we've had 5+ consecutive failures (likely curl_cffi not installed).
 */
export function isBrowserSessionAlive(): boolean {
  return state.consecutiveFailures < 5;
}

/**
 * Get transport health metrics for telemetry/Telegram commands.
 */
export function getBrowserSessionStats(): {
  alive: boolean;
  requestCount: number;
  directRequestCount: number;
  proxyRequestCount: number;
  consecutiveFailures: number;
  lastUsedAt: number;
  idleMs: number;
  directOnCooldown: boolean;
  directCooldownRemainingMs: number;
  proxyMonthlyLimit: number;
  proxyRemainingCredits: number;
} {
  const proxy = getProxyStats();
  return {
    alive: isBrowserSessionAlive(),
    requestCount: state.requestCount,
    directRequestCount: state.directRequestCount,
    proxyRequestCount: state.proxyRequestCount,
    consecutiveFailures: state.consecutiveFailures,
    lastUsedAt: state.lastUsedAt,
    idleMs: state.lastUsedAt > 0 ? Date.now() - state.lastUsedAt : 0,
    directOnCooldown: proxy.directOnCooldown,
    directCooldownRemainingMs: proxy.directCooldownRemainingMs,
    proxyMonthlyLimit: proxy.monthlyLimit,
    proxyRemainingCredits: proxy.remainingCredits,
  };
}

/**
 * No-op for API compatibility — no persistent session to close.
 */
export async function closeSofaScoreSession(): Promise<void> {
  // Nothing to close — each request is a self-contained Python process
  logger.info(LOG_TAG, "Transport cleanup complete (no persistent session).");
}
