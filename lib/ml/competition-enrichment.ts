import { getGroundingEngine } from "@/lib/ai/grounding";
import { logger } from "@/lib/shared/logger";
import { getEvents } from "@/lib/store";
import { singleton } from "@/lib/util/singleton";

export type CompetitionLevel =
  | "top_domestic"
  | "lower_domestic"
  | "continental"
  | "cup"
  | "friendly"
  | "youth"
  | "women"
  | "unknown";

export interface CompetitionEnrichmentSource {
  title?: string;
  url?: string;
  snippet?: string;
}

export interface CompetitionEnrichment {
  name: string;
  displayName: string;
  tier: 1 | 2 | 3;
  marketEfficiencyScore: number;
  region: string | null;
  country: string | null;
  competitionLevel: CompetitionLevel;
  confidence: number;
  model: string | null;
  provider: string | null;
  promptVersion: string;
  sources: CompetitionEnrichmentSource[];
  rawResponse: unknown;
  classifiedAt: string;
}

interface EnrichmentState {
  cache: Map<string, CompetitionEnrichment>;
  loadPromise: Promise<void> | null;
  warmerTimer: ReturnType<typeof setInterval> | null;
  warming: boolean;
}

type DbModule = typeof import("@/lib/db/client");
type SchemaModule = typeof import("@/lib/db/schema");
type MaybeDefaultModule<T> = T & { default?: T };

const tag = "CompetitionEnrichment";
const PROMPT_VERSION = "competition-enrichment-v1";
const LOW_CONFIDENCE_THRESHOLD = 55;
const WARMER_INTERVAL_MS = 30 * 60 * 1000;
const REQUEST_DELAY_MS = 1200;

const state = singleton(
  "ml:competition-enrichment",
  (): EnrichmentState => ({
    cache: new Map(),
    loadPromise: null,
    warmerTimer: null,
    warming: false,
  }),
);

function normalizeCompetitionName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampTier(value: unknown): 1 | 2 | 3 {
  const tier = clampInt(value, 1, 3, 1);
  return tier === 3 ? 3 : tier === 2 ? 2 : 1;
}

function normalizeLevel(value: unknown): CompetitionLevel {
  const v = String(value ?? "unknown");
  const allowed: CompetitionLevel[] = [
    "top_domestic",
    "lower_domestic",
    "continental",
    "cup",
    "friendly",
    "youth",
    "women",
    "unknown",
  ];
  return allowed.includes(v as CompetitionLevel)
    ? (v as CompetitionLevel)
    : "unknown";
}

function defaultEnrichment(name: string): CompetitionEnrichment {
  return {
    name: normalizeCompetitionName(name),
    displayName: name.trim(),
    tier: 1,
    marketEfficiencyScore: 0,
    region: null,
    country: null,
    competitionLevel: "unknown",
    confidence: 0,
    model: null,
    provider: null,
    promptVersion: PROMPT_VERSION,
    sources: [],
    rawResponse: null,
    classifiedAt: new Date(0).toISOString(),
  };
}

function placeholderEnrichment(name: string): CompetitionEnrichment {
  return {
    ...defaultEnrichment(name),
    confidence: 100,
    provider: "deterministic",
    rawResponse: { reason: "non-informative competition placeholder" },
    classifiedAt: new Date().toISOString(),
  };
}

function isNonInformativeCompetition(name: string): boolean {
  return /^(fantasy match|other competitions soccer|other soccer|unknown|n\/a)$/i.test(
    normalizeCompetitionName(name),
  );
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

function buildPrompt(name: string): string {
  return [
    `Classify the football betting-market efficiency context for this competition: ${name}`,
    "",
    "Return only a JSON object with these keys:",
    "tier: 1 | 2 | 3, where 3 is most efficient and liquid, 1 is default/lower-confidence.",
    "market_efficiency_score: integer 0-100.",
    "region: string or null.",
    "country: string or null.",
    "competition_level: one of top_domestic, lower_domestic, continental, cup, friendly, youth, women, unknown.",
    "confidence: integer 0-100.",
    "",
    "Use conservative defaults when uncertain. Do not invent specificity.",
  ].join("\n");
}

function buildSearchQuery(name: string): string {
  return `${name} football competition league country market efficiency`;
}

function fromParsed(
  name: string,
  parsed: Record<string, unknown> | null,
  meta: {
    provider: string;
    model: string | null;
    rawResponse: unknown;
    sources?: CompetitionEnrichmentSource[];
  },
): CompetitionEnrichment {
  const fallback = defaultEnrichment(name);
  if (!parsed) {
    return {
      ...fallback,
      model: meta.model,
      provider: meta.provider,
      rawResponse: meta.rawResponse,
      classifiedAt: new Date().toISOString(),
    };
  }

  return {
    name: fallback.name,
    displayName: name.trim(),
    tier: clampTier(parsed.tier),
    marketEfficiencyScore: clampInt(parsed.market_efficiency_score, 0, 100, 0),
    region:
      typeof parsed.region === "string" && parsed.region.trim()
        ? parsed.region.trim()
        : null,
    country:
      typeof parsed.country === "string" && parsed.country.trim()
        ? parsed.country.trim()
        : null,
    competitionLevel: normalizeLevel(parsed.competition_level),
    confidence: clampInt(parsed.confidence, 0, 100, 0),
    model: meta.model,
    provider: meta.provider,
    promptVersion: PROMPT_VERSION,
    sources: meta.sources ?? [],
    rawResponse: meta.rawResponse,
    classifiedAt: new Date().toISOString(),
  };
}

function rowsToCache(
  rows: Array<{
    name: string;
    displayName: string;
    tier: number;
    marketEfficiencyScore: number;
    region: string | null;
    country: string | null;
    competitionLevel: string;
    confidence: number;
    model: string | null;
    provider: string | null;
    promptVersion: string;
    sources: unknown;
    rawResponse: unknown;
    classifiedAt: string;
  }>,
): void {
  for (const row of rows) {
    state.cache.set(row.name, {
      name: row.name,
      displayName: row.displayName,
      tier: clampTier(row.tier),
      marketEfficiencyScore: clampInt(row.marketEfficiencyScore, 0, 100, 0),
      region: row.region,
      country: row.country,
      competitionLevel: normalizeLevel(row.competitionLevel),
      confidence: clampInt(row.confidence, 0, 100, 0),
      model: row.model,
      provider: row.provider,
      promptVersion: row.promptVersion,
      sources: Array.isArray(row.sources)
        ? (row.sources as CompetitionEnrichmentSource[])
        : [],
      rawResponse: row.rawResponse,
      classifiedAt: row.classifiedAt,
    });
  }
}

async function loadDbModules(): Promise<{
  db: DbModule["db"];
  competitionEnrichments: SchemaModule["competitionEnrichments"];
  competitionTiers: SchemaModule["competitionTiers"];
}> {
  const [dbModuleRaw, schemaModuleRaw] = await Promise.all([
    import("@/lib/db/client"),
    import("@/lib/db/schema"),
  ]);
  const dbModule = dbModuleRaw as MaybeDefaultModule<DbModule>;
  const schemaModule = schemaModuleRaw as MaybeDefaultModule<SchemaModule>;
  const dbExports = dbModule.db ? dbModule : dbModule.default;
  const schemaExports = schemaModule.competitionEnrichments
    ? schemaModule
    : schemaModule.default;

  if (
    !dbExports?.db ||
    !schemaExports?.competitionEnrichments ||
    !schemaExports?.competitionTiers
  ) {
    throw new Error(
      "DB modules did not expose the expected competition enrichment exports",
    );
  }

  return {
    db: dbExports.db,
    competitionEnrichments: schemaExports.competitionEnrichments,
    competitionTiers: schemaExports.competitionTiers,
  };
}

export function getCompetitionEnrichment(name: string): CompetitionEnrichment {
  if (!name.trim()) return defaultEnrichment("");
  return (
    state.cache.get(normalizeCompetitionName(name)) ?? defaultEnrichment(name)
  );
}

export function getCompetitionTier(name: string): 1 | 2 | 3 {
  return getCompetitionEnrichment(name).tier;
}

export async function loadCompetitionEnrichmentCache(): Promise<void> {
  if (state.loadPromise) return state.loadPromise;

  state.loadPromise = (async () => {
    const { db, competitionEnrichments, competitionTiers } =
      await loadDbModules();

    const rows = await db.select().from(competitionEnrichments);
    rowsToCache(rows);

    const legacyRows = await db.select().from(competitionTiers);
    let legacyLoaded = 0;
    for (const row of legacyRows) {
      const key = normalizeCompetitionName(row.name);
      if (state.cache.has(key)) continue;
      state.cache.set(key, {
        ...defaultEnrichment(row.name),
        tier: clampTier(row.tier),
        marketEfficiencyScore: row.tier === 3 ? 85 : row.tier === 2 ? 60 : 30,
        confidence: 50,
        provider: "legacy",
        model: null,
        rawResponse: { competition_tiers: row },
        classifiedAt: row.classifiedAt,
      });
      legacyLoaded++;
    }

    logger.info(
      tag,
      `Loaded ${rows.length} competition enrichments` +
        (legacyLoaded ? ` and ${legacyLoaded} legacy tiers` : ""),
    );
  })().catch((err) => {
    state.loadPromise = null;
    logger.warn(tag, `Cache load failed: ${(err as Error).message}`);
  });

  return state.loadPromise;
}

async function enrichWithGroundedFallback(
  name: string,
): Promise<CompetitionEnrichment> {
  const engine = getGroundingEngine();
  const result = await engine.query(
    buildPrompt(name),
    {
      service: "CompetitionEnrichment",
      prompt_version: PROMPT_VERSION,
    },
    {
      searchQuery: buildSearchQuery(name),
      searchProviders: ["vertex"],
    },
  );

  return fromParsed(name, extractJsonObject(result.answer), {
    provider: "deepseek", // Default provider for grounding
    model: result.model,
    sources: result.sources.map((s) => ({
      title: s.title,
      url: s.url,
      snippet: s.snippet,
    })),
    rawResponse: result,
  });
}

export async function classifyCompetitionEnrichment(
  name: string,
): Promise<CompetitionEnrichment> {
  const clean = name.trim();
  if (!clean) return defaultEnrichment(clean);
  if (isNonInformativeCompetition(clean)) return placeholderEnrichment(clean);

  try {
    return await enrichWithGroundedFallback(clean);
  } catch (err) {
    logger.warn(
      tag,
      `Grounded enrichment failed for ${clean}: ${(err as Error).message}`,
    );
    return {
      ...defaultEnrichment(clean),
      rawResponse: { error: err instanceof Error ? err.message : String(err) },
      classifiedAt: new Date().toISOString(),
    };
  }
}

async function saveEnrichment(
  enrichment: CompetitionEnrichment,
): Promise<void> {
  const { db, competitionEnrichments } = await loadDbModules();

  await db
    .insert(competitionEnrichments)
    .values({
      name: enrichment.name,
      displayName: enrichment.displayName,
      tier: enrichment.tier,
      marketEfficiencyScore: enrichment.marketEfficiencyScore,
      region: enrichment.region,
      country: enrichment.country,
      competitionLevel: enrichment.competitionLevel,
      confidence: enrichment.confidence,
      model: enrichment.model,
      provider: enrichment.provider,
      promptVersion: enrichment.promptVersion,
      sources: enrichment.sources,
      rawResponse: enrichment.rawResponse,
      classifiedAt: enrichment.classifiedAt,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: competitionEnrichments.name,
      set: {
        displayName: enrichment.displayName,
        tier: enrichment.tier,
        marketEfficiencyScore: enrichment.marketEfficiencyScore,
        region: enrichment.region,
        country: enrichment.country,
        competitionLevel: enrichment.competitionLevel,
        confidence: enrichment.confidence,
        model: enrichment.model,
        provider: enrichment.provider,
        promptVersion: enrichment.promptVersion,
        sources: enrichment.sources,
        rawResponse: enrichment.rawResponse,
        classifiedAt: enrichment.classifiedAt,
        updatedAt: new Date().toISOString(),
      },
    });
}

function shouldWarm(name: string): boolean {
  const cached = state.cache.get(normalizeCompetitionName(name));
  return cached == null || cached.confidence < LOW_CONFIDENCE_THRESHOLD;
}

export async function warmCompetitionEnrichmentCache(
  limit = 20,
): Promise<void> {
  if (state.warming) return;
  state.warming = true;

  try {
    await loadCompetitionEnrichmentCache();

    const competitions = new Set<string>();
    for (const event of getEvents()) {
      if (event.competition?.trim() && shouldWarm(event.competition)) {
        competitions.add(event.competition.trim());
      }
    }

    const queue = Array.from(competitions).slice(0, limit);
    if (queue.length === 0) return;

    logger.info(tag, `Warming ${queue.length} competition enrichments`);
    for (const competition of queue) {
      const enrichment = await classifyCompetitionEnrichment(competition);
      state.cache.set(enrichment.name, enrichment);
      await saveEnrichment(enrichment);
      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
    }
  } finally {
    state.warming = false;
  }
}

export function startCompetitionEnrichmentWarmer(): void {
  if (state.warmerTimer) return;

  warmCompetitionEnrichmentCache().catch((err) =>
    logger.warn(tag, `Initial warmup failed: ${(err as Error).message}`),
  );
  state.warmerTimer = setInterval(() => {
    warmCompetitionEnrichmentCache().catch((err) =>
      logger.warn(tag, `Periodic warmup failed: ${(err as Error).message}`),
    );
  }, WARMER_INTERVAL_MS);
}

export function stopCompetitionEnrichmentWarmer(): void {
  if (!state.warmerTimer) return;
  clearInterval(state.warmerTimer);
  state.warmerTimer = null;
}
