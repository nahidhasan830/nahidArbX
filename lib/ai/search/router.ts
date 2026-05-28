import { type SearchResult, type ProviderStats } from "./types";
import { VertexSearchProvider } from "./providers/vertex";
import { BraveSearchProvider } from "./providers/brave";
import { TavilySearchProvider } from "./providers/tavily";
import { logger } from "@/lib/shared/logger";
import { logAiActivity } from "@/lib/ai/activity-logger";
import {
  seedProvidersIfEmpty,
  setProviderEnabled,
  getProviderConfigs,
} from "@/lib/db/repositories/ai-provider-config";

const tag = "SearchRouter";

type SearchQuality = {
  strong: boolean;
  resultCount: number;
  contentChars: number;
  reason: string;
};

interface Provider {
  name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
  get healthy(): boolean;
  get enabled(): boolean;
  enable(): void;
  disable(): void;
  markUnhealthy(error: string, cooldownMs?: number): void;
  hasQuota(): boolean;
  getStats(): ProviderStats;
}

export class SearchRouter {
  private _providers: Provider[] = [];
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    this._initPromise = this._init();
  }

  private async _init() {
    if (this._initialized) return;

    // Seed providers in DB
    await seedProvidersIfEmpty();

    // Check DB config for enabled state
    const configs = await getProviderConfigs();

    this._providers.push(new VertexSearchProvider());
    if (configs["vertex"]?.enabled ?? true) {
      (this._providers[0] as VertexSearchProvider).enable();
    } else {
      (this._providers[0] as VertexSearchProvider).disable();
    }
    logger.info(tag, "Vertex AI Search enabled (primary)");

    this._providers.push(new BraveSearchProvider());
    if (configs["brave"]?.enabled ?? true) {
      (this._providers[1] as BraveSearchProvider).enable();
    } else {
      (this._providers[1] as BraveSearchProvider).disable();
    }
    logger.info(tag, "Brave Search enabled (secondary)");

    this._providers.push(new TavilySearchProvider());
    if (configs["tavily"]?.enabled ?? true) {
      (this._providers[2] as TavilySearchProvider).enable();
    } else {
      (this._providers[2] as TavilySearchProvider).disable();
    }
    logger.info(tag, "Tavily Search enabled (tertiary)");

    this._initialized = true;
  }

  get providers(): Provider[] {
    return [...this._providers];
  }

  async search(
    query: string,
    maxResults = 5,
    preferredProviders?: string[],
  ): Promise<{ results: SearchResult[]; provider: string }> {
    await this._ensureInit();
    const available = this._getAvailable(preferredProviders);
    const attempts: Array<{
      provider: string;
      resultCount: number;
      contentChars: number;
      strong: boolean;
      reason: string;
    }> = [];
    const successfulResults: SearchResult[] = [];
    let best:
      | { results: SearchResult[]; provider: string; quality: SearchQuality }
      | null = null;

    for (const p of available) {
      try {
        let quality: SearchQuality = {
          strong: false,
          resultCount: 0,
          contentChars: 0,
          reason: "not-run",
        };
        const results = await logAiActivity(
          {
            system: "search",
            provider: p.name,
            endpoint: "search",
            query: query.slice(0, 200),
            itemCount: 1,
            request: { query, maxResults, preferredProviders },
            response: (found: unknown) => {
              const results = Array.isArray(found)
                ? (found as SearchResult[])
                : [];
              return {
                resultCount: results.length,
                quality: scoreSearchQuality(results, maxResults),
                results: results.slice(0, maxResults).map((r) => ({
                  title: r.title,
                  url: r.url,
                  snippet: r.snippet,
                  content: r.content ?? r.snippet,
                  source: r.source,
                  score: r.score ?? null,
                })),
              };
            },
            metadata: { provider: p.name },
          },
          async () => {
            const found = await p.search(query, maxResults);
            quality = scoreSearchQuality(found, maxResults);
            return found;
          },
        );
        attempts.push({ provider: p.name, ...quality });
        successfulResults.push(...results);
        logger.info(
          tag,
          `Search via ${p.name}: ${results.length} results for "${query.slice(0, 80)}"`,
        );

        if (!best || quality.contentChars > best.quality.contentChars) {
          best = { results, provider: p.name, quality };
        }

        if (quality.strong) {
          const provider =
            attempts.length > 1
              ? attempts.map((a) => a.provider).join("+")
              : p.name;
          const merged =
            attempts.length > 1
              ? dedupeSearchResults(successfulResults)
              : results;
          return { results: merged.slice(0, maxResults), provider };
        }

        logger.info(
          tag,
          `Search via ${p.name} was weak (${quality.reason}) — trying fallback`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isQueryError = err instanceof Error && "isQueryError" in err;
        if (isQueryError) {
          logger.warn(tag, `Provider ${p.name} rejected query: ${msg}`);
        } else {
          logger.warn(tag, `Provider ${p.name} failed: ${msg} — trying next`);
          p.markUnhealthy(msg);
        }
      }
    }

    if (best && best.results.length > 0) {
      logger.warn(
        tag,
        `All search providers were weak; using best result from ${best.provider} (${best.quality.reason})`,
      );
      return { results: best.results, provider: best.provider };
    }

    logger.error(
      tag,
      `All search providers failed for: "${query.slice(0, 80)}"`,
    );
    return { results: [], provider: "none" };
  }

  async fanOutSearch(
    query: string,
    maxResults = 5,
    fanOut = 2,
  ): Promise<{ results: SearchResult[]; provider: string }> {
    await this._ensureInit();
    const available = this._getAvailable().slice(0, fanOut);
    if (available.length === 0) {
      return { results: [], provider: "none" };
    }

    const results = await Promise.allSettled(
      available.map(async (p) => {
        try {
          const r = await p.search(query, maxResults);
          return { results: r, name: p.name };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          p.markUnhealthy(msg);
          return { results: [], name: p.name };
        }
      }),
    );

    const allResults: SearchResult[] = [];
    const providersUsed: string[] = [];

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.results.length > 0) {
        allResults.push(...r.value.results);
        providersUsed.push(r.value.name);
      }
    }

    const seen = new Set<string>();
    const deduped = allResults.filter((r) => {
      const key = r.url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      results: deduped.slice(0, maxResults * fanOut),
      provider: providersUsed.join("+") || "none",
    };
  }

  getStats() {
    const providerStats = this._providers.map((p) => p.getStats());
    const total = providerStats.reduce((sum, p) => sum + p.requestsUsed, 0);
    return { providers: providerStats, totalSearches: total };
  }

  async toggleProvider(name: string, enabled: boolean): Promise<boolean> {
    await this._ensureInit();
    for (const p of this._providers) {
      if (p.name === name) {
        if (enabled) p.enable();
        else p.disable();
        // Persist to DB
        await setProviderEnabled(name, enabled);
        logger.info(
          tag,
          `Provider ${p.name} ${enabled ? "enabled" : "disabled"}`,
        );
        return true;
      }
    }
    return false;
  }

  private async _ensureInit() {
    if (!this._initialized) {
      this._initPromise ??= this._init();
      await this._initPromise;
    }
  }

  private _getAvailable(preferred?: string[]): Provider[] {
    let candidates = this._providers;

    if (preferred && preferred.length > 0) {
      const set = new Set(preferred.map((n) => n.toLowerCase()));
      const filtered = candidates.filter((p) => set.has(p.name));
      if (filtered.length > 0) candidates = filtered;
    }

    return candidates.filter((p) => p.healthy && p.hasQuota() && p.enabled);
  }
}

function scoreSearchQuality(
  results: SearchResult[],
  requestedResults: number,
): SearchQuality {
  const resultCount = results.length;
  const contentChars = results.reduce(
    (sum, r) => sum + (r.content || r.snippet || "").trim().length,
    0,
  );
  const enoughResults = resultCount >= Math.min(3, requestedResults);
  const enoughText = contentChars >= 300;
  const strong = enoughResults && enoughText;
  const reason = strong
    ? "enough-results-and-text"
    : !enoughResults
      ? "too-few-results"
      : "too-little-text";

  return { strong, resultCount, contentChars, reason };
}

function dedupeSearchResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const r of results) {
    const key = (r.url || `${r.source}:${r.title}`).replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

let _instance: SearchRouter | null = null;

export function getSearchRouter(): SearchRouter {
  if (!_instance) {
    _instance = new SearchRouter();
  }
  return _instance;
}
