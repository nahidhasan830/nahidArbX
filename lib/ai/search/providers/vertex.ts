import { type SearchResult } from "../types";
import { buildVertexSearchQueries } from "../query-rewrites";
import { refineVertexSearchQueries } from "../query-refiner";
import { isStrongVertexSearchResult } from "../quality";
import { logger } from "@/lib/shared/logger";
import {
  getProviderByName,
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

  get healthy() {
    return this._healthy;
  }
  get enabled() {
    return this._enabled;
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
      }
    } catch {
      // Best-effort
    }
  }

  markUnhealthy(error: string, cooldownMs = 60_000) {
    this._healthy = false;
    this._lastError = error;
    setTimeout(() => {
      this._healthy = true;
    }, cooldownMs);
  }

  hasQuota(): boolean {
    return this._enabled;
  }

  async checkQuotaAndIncrement(): Promise<boolean> {
    const result = await incrementUsage(this.name);
    if (result) this._sessionRequests = result.monthlyUsageCount;
    return true;
  }

  getStats() {
    return {
      name: this.name,
      healthy: this._healthy,
      enabled: this._enabled,
      requestsUsed: this._sessionRequests,
      quotaLimit: null,
      quotaRemaining: null,
      quotaSource: "none" as const,
      lastError: this._lastError,
      lastUsedAt: this._lastUsedAt?.toISOString() ?? null,
    };
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    const config = getConfig();
    if (!config.projectId || !config.engineId) {
      throw new Error(
        "Vertex AI Search not configured (missing GCP_PROJECT_ID or VERTEX_ENGINE_ID)",
      );
    }

    if (!(await this.checkQuotaAndIncrement())) {
      throw new Error("Vertex Search disabled");
    }

    const variants = buildVertexSearchQueries(query);
    let bestResults: SearchResult[] = [];
    let bestVariantReason = "not-run";
    let bestContentChars = 0;
    const attemptedQueries: string[] = [];

    for (const [index, variant] of variants.entries()) {
      attemptedQueries.push(variant.query);
      const results = await this._searchOnce(variant.query, maxResults, config);
      const contentChars = results.reduce(
        (sum, r) => sum + (r.content || r.snippet || "").trim().length,
        0,
      );
      if (
        results.length > bestResults.length ||
        (results.length === bestResults.length &&
          contentChars > bestContentChars)
      ) {
        bestResults = results;
        bestVariantReason = variant.reason;
        bestContentChars = contentChars;
      }

      if (
        isStrongVertexSearchResult(results.length, contentChars, maxResults)
      ) {
        if (index > 0 || variant.query !== query) {
          logger.info(
            tag,
            `Resolved via ${variant.reason} rewrite for "${query.slice(0, 80)}"`,
          );
        }
        return withVertexQueryMetadata(results.slice(0, maxResults), {
          query: variant.query,
          reason: variant.reason,
          attempts: index + 1,
          originalQuery: query,
        });
      }
    }

    const refinedVariants = await refineVertexSearchQueries({
      originalQuery: query,
      attemptedQueries,
    });

    for (const [index, variant] of refinedVariants.entries()) {
      attemptedQueries.push(variant.query);
      const results = await this._searchOnce(variant.query, maxResults, config);
      const contentChars = results.reduce(
        (sum, r) => sum + (r.content || r.snippet || "").trim().length,
        0,
      );
      if (
        results.length > bestResults.length ||
        (results.length === bestResults.length &&
          contentChars > bestContentChars)
      ) {
        bestResults = results;
        bestVariantReason = variant.reason;
        bestContentChars = contentChars;
      }

      if (
        isStrongVertexSearchResult(results.length, contentChars, maxResults)
      ) {
        logger.info(
          tag,
          `Resolved via ${variant.reason} DeepSeek rewrite for "${query.slice(0, 80)}"`,
        );
        return withVertexQueryMetadata(results.slice(0, maxResults), {
          query: variant.query,
          reason: variant.reason,
          attempts: variants.length + index + 1,
          originalQuery: query,
        });
      }
    }

    logger.info(
      tag,
      `${bestResults.length} best results for "${query.slice(0, 80)}"` +
        (bestVariantReason === "original" ? "" : ` via ${bestVariantReason}`),
    );
    return withVertexQueryMetadata(bestResults.slice(0, maxResults), {
      query: variants[0]?.query ?? query,
      reason: bestVariantReason,
      attempts: variants.length,
      originalQuery: query,
    });
  }

  private async _searchOnce(
    query: string,
    maxResults: number,
    config: ReturnType<typeof getConfig>,
  ): Promise<SearchResult[]> {
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
        relevanceThreshold: "LOWEST",
        contentSearchSpec: {
          snippetSpec: {
            returnSnippet: true,
            maxSnippetCount: 3,
          },
          extractiveContentSpec: {
            maxExtractiveAnswerCount: 1,
            maxExtractiveSegmentCount: 1,
          },
        },
        languageCode: "en-US",
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Vertex AI Search returned ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as {
      results?: Array<{
        document?: {
          derivedStructData?: {
            title?: string;
            link?: string;
            snippets?: Array<{ snippet?: string }>;
            extractive_answers?: Array<{ content?: string }>;
            extractiveAnswer?: Array<{ content?: string }>;
            extractive_segments?: Array<{ content?: string }>;
            extractiveSegment?: Array<{ content?: string }>;
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
      const snippet = collectSnippets(doc).join(" ");
      const extractiveContent = collectExtractiveContent(doc).join("\n\n");
      const content = [extractiveContent, snippet].filter(Boolean).join("\n\n");
      results.push({
        title: doc.title || "",
        url: doc.link || "",
        snippet,
        content: content || snippet,
        source: "vertex",
      });
    }

    logger.info(tag, `${results.length} results for "${query.slice(0, 80)}"`);
    return results.slice(0, maxResults);
  }
}

function withVertexQueryMetadata(
  results: SearchResult[],
  metadata: {
    query: string;
    reason: string;
    attempts: number;
    originalQuery: string;
  },
): SearchResult[] {
  return results.map((result) => ({
    ...result,
    source: "vertex",
    content: result.content ?? result.snippet,
    metadata: {
      ...(result.metadata ?? {}),
      vertexQuery: metadata.query,
      vertexQueryReason: metadata.reason,
      vertexQueryAttempts: metadata.attempts,
      vertexOriginalQuery: metadata.originalQuery,
    },
  })) as SearchResult[];
}

function collectSnippets(doc: {
  snippets?: Array<{ snippet?: string }>;
}): string[] {
  return (doc.snippets ?? [])
    .map((s) => normalizeText(s.snippet ?? ""))
    .filter(Boolean)
    .slice(0, 3);
}

function collectExtractiveContent(doc: {
  extractive_answers?: Array<{ content?: string }>;
  extractiveAnswer?: Array<{ content?: string }>;
  extractive_segments?: Array<{ content?: string }>;
  extractiveSegment?: Array<{ content?: string }>;
}): string[] {
  return [
    ...(doc.extractive_answers ?? []),
    ...(doc.extractiveAnswer ?? []),
    ...(doc.extractive_segments ?? []),
    ...(doc.extractiveSegment ?? []),
  ]
    .map((s) => normalizeText(s.content ?? ""))
    .filter(Boolean)
    .slice(0, 2);
}

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
