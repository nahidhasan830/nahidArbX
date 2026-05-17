import { type SearchResult } from "../types";
import { logger } from "@/lib/shared/logger";
import {
  getProviderByName,
  hasQuota as dbHasQuota,
  incrementUsage,
} from "@/lib/db/repositories/ai-provider-config";

const tag = "VertexSearch";

const DISCOVERY_API = "https://discoveryengine.googleapis.com/v1alpha";

function getConfig() {
  return {
    projectId: process.env.GCP_PROJECT_ID || "",
    engineId: process.env.VERTEX_ENGINE_ID || "",
    location: process.env.VERTEX_LOCATION || "global",
  };
}

export class VertexSearchProvider {
  readonly name = "vertex";
  private _healthy = true;
  private _enabled = true;
  private _lastError: string | null = null;
  private _lastUsedAt: Date | null = null;
  private _sessionRequests = 0;
  private _serverRemaining: number | null = null;
  private _serverLimit: number | null = null;

  get healthy() { return this._healthy; }
  get enabled() { return this._enabled; }

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
  }

  hasQuota(): boolean {
    if (this._serverRemaining !== null) return this._serverRemaining > 0;
    return this._enabled;
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
    const limit = this._serverLimit ?? 1000;
    const remaining = this._serverRemaining ?? Math.max(0, limit - this._sessionRequests);
    return {
      name: this.name,
      healthy: this._healthy,
      enabled: this._enabled,
      requestsUsed: this._sessionRequests,
      quotaLimit: this._serverLimit ?? limit,
      quotaRemaining: remaining,
      quotaSource: this._serverRemaining !== null ? "db" as const : "none" as const,
      lastError: this._lastError,
      lastUsedAt: this._lastUsedAt?.toISOString() ?? null,
    };
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const config = getConfig();
    if (!config.projectId || !config.engineId) {
      throw new Error("Vertex AI Search not configured (missing GCP_PROJECT_ID or VERTEX_ENGINE_ID)");
    }

    // Check and increment quota
    if (!(await this.checkQuotaAndIncrement())) {
      throw new Error("Vertex Search quota exhausted");
    }

    const servingConfig = `projects/${config.projectId}/locations/${config.location}/collections/default_collection/engines/${config.engineId}/servingConfigs/default_search`;
    const url = `${DISCOVERY_API}/${servingConfig}:search`;

    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token.token}`,
      },
      body: JSON.stringify({
        query,
        pageSize: maxResults,
        queryExpansionSpec: { condition: "AUTO" },
        spellCorrectionSpec: { mode: "AUTO" },
        languageCode: "en-US",
        userInfo: { timeZone: "Asia/Dhaka" },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Vertex AI Search returned ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      results?: Array<{
        document?: {
          derivedStructData?: {
            title?: string;
            link?: string;
            snippets?: Array<{ snippet?: string }>;
          };
        };
      }>;
    };

    this._lastUsedAt = new Date();
    this._healthy = true;
    this._lastError = null;

    const results: SearchResult[] = [];
    for (const item of data.results ?? []) {
      const doc = item.document?.derivedStructData;
      if (!doc) continue;
      results.push({
        title: doc.title || "",
        url: doc.link || "",
        snippet: doc.snippets?.[0]?.snippet || "",
        source: "vertex",
      });
    }

    logger.info(tag, `${results.length} results for "${query.slice(0, 80)}"`);
    return results.slice(0, maxResults);
  }
}