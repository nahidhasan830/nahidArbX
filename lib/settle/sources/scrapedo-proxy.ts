
import axios, { type AxiosRequestConfig } from "axios";
import { singleton } from "../../util/singleton";
import { logger } from "../../shared/logger";
import { format } from "date-fns";


const SCRAPE_DO_TOKEN =
  process.env.SCRAPE_DO_TOKEN ?? "3c8036cf1404454a88fc06efe50cb0ee934edfbf8ae";

const SCRAPE_DO_BASE = "https://api.scrape.do";
const MIN_REQUEST_SPACING_MS = 2_500;

const DIRECT_COOLDOWN_MS = 10 * 60 * 1000;

const MONTHLY_LIMIT = 1_000;
const WARN_THRESHOLD = 0.8;


interface ProxyState {
  lastDirect403At: number;
  lastProxyRequestAt: number;
  monthKey: string;
  usedCredits: number;
}

function currentMonthKey(): string {
  return format(new Date(), "yyyy-MM");
}

const state = singleton<ProxyState>("settle:scrapedo-proxy", () => ({
  lastDirect403At: 0,
  lastProxyRequestAt: 0,
  monthKey: currentMonthKey(),
  usedCredits: 0,
}));

function ensureMonthReset(): void {
  const key = currentMonthKey();
  if (state.monthKey !== key) {
    logger.info(
      "ScrapeDoProxy",
      `Month rolled ${state.monthKey} → ${key}. Resetting usage counter (was ${state.usedCredits}).`,
    );
    state.monthKey = key;
    state.usedCredits = 0;
  }
}


export async function fetchViaScrapeDoProxy<T>(
  targetUrl: string,
  timeoutMs: number = 30_000,
): Promise<T | null> {
  ensureMonthReset();

  if (state.usedCredits >= MONTHLY_LIMIT) {
    logger.warn(
      "ScrapeDoProxy",
      `Monthly limit reached (${state.usedCredits}/${MONTHLY_LIMIT}) — refusing proxy request.`,
    );
    return null;
  }

  const waitMs = Math.max(
    0,
    MIN_REQUEST_SPACING_MS - (Date.now() - state.lastProxyRequestAt),
  );
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  state.lastProxyRequestAt = Date.now();

  const cfg: AxiosRequestConfig = {
    method: "get",
    url: SCRAPE_DO_BASE,
    timeout: timeoutMs,
    headers: { Accept: "application/json" },
    params: {
      token: SCRAPE_DO_TOKEN,
      url: targetUrl,
      super: "true",
    },
  };

  try {
    const { data } = await axios.request<T>(cfg);
    state.usedCredits++;

    if (
      state.usedCredits === Math.ceil(MONTHLY_LIMIT * WARN_THRESHOLD) ||
      state.usedCredits === MONTHLY_LIMIT - 50
    ) {
      logger.warn(
        "ScrapeDoProxy",
        `Monthly usage: ${state.usedCredits}/${MONTHLY_LIMIT} credits.`,
      );
    }

    return data;
  } catch (err) {
    const status = (err as { response?: { status?: number } }).response?.status;
    if (status === 404) return null;
    if (status === 429) {
      logger.warn(
        "ScrapeDoProxy",
        `Proxy GET ${targetUrl} was rate-limited (HTTP 429). The settlement scheduler will retry later.`,
      );
      return null;
    }
    if (status === 401) {
      logger.warn(
        "ScrapeDoProxy",
        `Scrape.do authentication failed (HTTP 401) for ${targetUrl}. Check SCRAPE_DO_TOKEN / account status. Proxy disabled until resolved; SofaScore direct will be used when possible.`,
      );
      state.lastDirect403At = Date.now();
      return null;
    }
    logger.warn(
      "ScrapeDoProxy",
      `Proxy GET ${targetUrl} failed (HTTP ${status ?? "N/A"}): ${(err as Error).message}`,
    );
    return null;
  }
}

export function reportDirect403(): void {
  state.lastDirect403At = Date.now();
}

export function isDirectOnCooldown(): boolean {
  if (state.lastDirect403At === 0) return false;
  return Date.now() - state.lastDirect403At < DIRECT_COOLDOWN_MS;
}

export function isProxyAvailable(): boolean {
  ensureMonthReset();
  return state.usedCredits < MONTHLY_LIMIT;
}

export interface ProxyPoolStats {
  service: "scrape.do";
  monthlyLimit: number;
  usedCredits: number;
  remainingCredits: number;
  directOnCooldown: boolean;
  directCooldownRemainingMs: number;
}

export function getProxyStats(): ProxyPoolStats {
  ensureMonthReset();
  const remaining = Math.max(
    0,
    state.lastDirect403At === 0
      ? 0
      : DIRECT_COOLDOWN_MS - (Date.now() - state.lastDirect403At),
  );
  return {
    service: "scrape.do",
    monthlyLimit: MONTHLY_LIMIT,
    usedCredits: state.usedCredits,
    remainingCredits: Math.max(0, MONTHLY_LIMIT - state.usedCredits),
    directOnCooldown: remaining > 0,
    directCooldownRemainingMs: remaining,
  };
}
