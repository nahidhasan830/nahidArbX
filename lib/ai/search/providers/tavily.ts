import { type SearchResult } from "../types";
import { logger } from "@/lib/shared/logger";
import {
  getProviderByName,
  hasQuota as dbHasQuota,
  incrementUsage,
} from "@/lib/db/repositories/ai-provider-config";

const tag = "TavilySearch";

export class TavilySearchProvider {
  readonly name = "tavily";
  private _healthy = true;
  private _enabled = true;
  private _lastError: string | null = null;
  private _lastUsedAt: Date | null = null;
  private _sessionRequests = 0;
  private _serverRemaining: number | null = null;
  private _serverLimit: number | null = null;
  private _serverUsed: number | null = null;

  get healthy() { return this._healthy; }
  get enabled() { return this._enabled && Boolean(this._apiKey); }

  private get _apiKey(): string {
    return process.env.TAVILY_API_KEY || "";
  }

  enable() { this._enabled = true; }
  disable() { this._enabled = false; }

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
      // Best-effort
    }
  }

  markUnhealthy(error: string, cooldownMs = 60_000) {
    this._healthy = false;
    this._lastError = error;
    setTimeout(() => { this._healthy = true; }, cooldownMs);
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
    const remaining = this._serverRemaining ?? Math.max(0, limit - this._sessionRequests);
    return {
      name: this.name,
      healthy: this._healthy,
      enabled: this._enabled && Boolean(this._apiKey),
      requestsUsed: used,
      quotaLimit: this._serverLimit ?? limit,
      quotaRemaining: remaining,
      quotaSource: (this._serverRemaining !== null ? "live" : this._sessionRequests > 0 ? "local" : "none") as "live" | "local" | "none",
      lastError: this._lastError,
      lastUsedAt: this._lastUsedAt?.toISOString() ?? null,
    };
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!this._apiKey) {
      throw new Error("Tavily API key not configured");
    }

    // Check and increment quota
    if (!(await this.checkQuotaAndIncrement())) {
      throw new Error("Tavily quota exhausted");
    }

    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: this._apiKey,
        query,
        search_depth: "basic",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Tavily returned ${res.status}`);
    }

    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    this._lastUsedAt = new Date();
    this._healthy = true;
    this._lastError = null;

    await this._syncUsage();

    const results: SearchResult[] = [];
    for (const item of data.results ?? []) {
      results.push({
        title: item.title || "",
        url: item.url || "",
        snippet: item.content || "",
        source: "tavily",
      });
    }

    logger.info(tag, `${results.length} results for "${query.slice(0, 80)}"`);
    return results.slice(0, maxResults);
  }

  private async _syncUsage() {
    if (!this._apiKey) return;
    try {
      const res = await fetch("https://api.tavily.com/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this._apiKey }),
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { usage?: number; limit?: number };
        if (data.usage !== undefined) {
          this._serverUsed = data.usage;
        }
        if (data.limit !== undefined) {
          this._serverLimit = data.limit;
          if (this._serverUsed !== null) {
            this._serverRemaining = Math.max(0, data.limit - this._serverUsed);
          }
        }
      }
    } catch {
      // Usage sync is best-effort
    }
  }
}