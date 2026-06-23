
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
          const msg = stderr?.trim()
            ? `${err.message} | stderr: ${stderr.trim().slice(0, 200)}`
            : err.message;
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );
    child.unref?.();
  });
}


const SOFASCORE_API_BASE = "https://api.sofascore.com";

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

export function isBrowserSessionAlive(): boolean {
  return state.consecutiveFailures < 5;
}

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

export async function closeSofaScoreSession(): Promise<void> {
  logger.info(LOG_TAG, "Transport cleanup complete (no persistent session).");
}
