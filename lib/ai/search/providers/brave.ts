import { type SearchResult } from "../types";
import { logger } from "@/lib/shared/logger";
import {
  getProviderByName,
  hasQuota as dbHasQuota,
  incrementUsage,
} from "@/lib/db/repositories/ai-provider-config";

const tag = "BraveSearch";

export class BraveSearchProvider {
  readonly name = "brave";
  private _healthy = true;
  private _enabled = true;
  private _lastError: string | null = null;
  private _lastUsedAt: Date | null = null;
  private _sessionRequests = 0;
  private _serverRemaining: number | null = null;
  private _serverLimit: number | null = null;
  private _serverUsed: number | null = null;

  get healthy() {
    return this._healthy;
  }
  get enabled() {
    return this._enabled && Boolean(this._apiKey);
  }

  private get _apiKey(): string {
    return process.env.BRAVE_SEARCH_API_KEY || "";
  }

  enable() {
    this._enabled = true;
  }
  disable() {
    this._enabled = false;
  }

  async _syncFromDb() {
    try {
      const provider = await getProviderByName(this.name);
      if (provider) {
        this._enabled = provider.enabled;
        if (provider.hasMonthlyLimit) {
          this._serverLimit = provider.monthlyLimit;
          this._serverRemaining = provider.monthlyRemaining;
        }
      }
    } catch {
    }
  }

  markUnhealthy(error: string, cooldownMs = 60_000) {
    this._healthy = false;
    this._lastError = error;
    setTimeout(() => {
      this._healthy = true;
    }, cooldownMs);
    logger.warn(tag, `Marked unhealthy: ${error}`);
  }

  hasQuota(): boolean {
    if (this._serverRemaining !== null) return this._serverRemaining > 0;
    if (!this._apiKey) return false;
    return true;
  }

  async checkQuotaAndIncrement(): Promise<boolean> {
    const has = await dbHasQuota(this.name);
    if (!has) {
      this.disable();
      return false;
    }

    const result = await incrementUsage(this.name);
    if (!result) {
      this.disable();
      return false;
    }

    this._sessionRequests = result.monthlyUsageCount;
    return true;
  }

  getStats() {
    const used = this._serverUsed ?? this._sessionRequests;
    const limit = this._serverLimit ?? 1000;
    const remaining =
      this._serverRemaining ?? Math.max(0, limit - this._sessionRequests);
    return {
      name: this.name,
      healthy: this._healthy,
      enabled: this._enabled && Boolean(this._apiKey),
      requestsUsed: used,
      quotaLimit: this._serverLimit ?? limit,
      quotaRemaining: remaining,
      quotaSource: (this._serverRemaining !== null
        ? "live"
        : this._sessionRequests > 0
          ? "local"
          : "none") as "live" | "local" | "none",
      lastError: this._lastError,
      lastUsedAt: this._lastUsedAt?.toISOString() ?? null,
    };
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!this._apiKey) {
      throw new Error("Brave Search API key not configured");
    }

    if (!(await this.checkQuotaAndIncrement())) {
      throw new Error("Brave Search quota exhausted");
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}&text_decorations=false`;

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this._apiKey,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 422) {
      throw Object.assign(new Error(`Brave rejected query (422)`), {
        isQueryError: true,
      });
    }

    if (!res.ok) {
      throw new Error(`Brave Search returned ${res.status}`);
    }

    this._parseRateLimitHeaders(res.headers);

    const data = (await res.json()) as {
      web?: {
        results?: Array<{ title?: string; url?: string; description?: string }>;
      };
    };

    this._lastUsedAt = new Date();
    this._healthy = true;
    this._lastError = null;

    const results: SearchResult[] = [];
    for (const item of data.web?.results ?? []) {
      results.push({
        title: item.title || "",
        url: item.url || "",
        snippet: item.description || "",
        content: item.description || "",
        source: "brave",
      });
    }

    logger.info(tag, `${results.length} results for "${query.slice(0, 80)}"`);
    return results.slice(0, maxResults);
  }

  private _parseRateLimitHeaders(headers: Headers) {
    const remainingStr = headers.get("x-ratelimit-remaining");
    const limitStr = headers.get("x-ratelimit-limit");
    const policy = headers.get("x-ratelimit-policy") || "";

    if (!remainingStr || !limitStr) return;

    const remaining = parseInt(remainingStr, 10);
    const limit = parseInt(limitStr, 10);
    if (isNaN(remaining) || isNaN(limit)) return;

    const monthlyLimit = this._parseMonthlyLimit(policy);
    if (monthlyLimit !== null && limit === monthlyLimit) {
      this._serverRemaining = remaining;
      this._serverLimit = monthlyLimit;
      this._serverUsed = monthlyLimit - remaining;
    } else if (limit >= 100) {
      this._serverRemaining = remaining;
      this._serverLimit = limit;
      this._serverUsed = limit - remaining;
    }
  }

  private _parseMonthlyLimit(policy: string): number | null {
    if (!policy) return null;
    for (const part of policy.split(",")) {
      const trimmed = part.trim();
      if (trimmed.includes(";w=")) {
        const [, windowPart] = trimmed.split(";w=", 2);
        const window = parseInt(windowPart, 10);
        if (window >= 86400) {
          const limitPart = trimmed.split(";w=")[0];
          return parseInt(limitPart, 10);
        }
      }
    }
    return null;
  }
}
