/**
 * Settlement-specific alias helpers.
 *
 * Two concerns on top of the entity-resolution store:
 *
 *   1. A thin wrapper that consults the entity-resolver to canonicalize
 *      a team name before settlement runs fuzzy matching against score
 *      sources. Replaces the old in-memory `getTeamAliases()` lookup.
 *
 *   2. A `competition_slugs.json` store that maps a normalized
 *      competition string to the slug a given score source uses
 *      (ESPN, football-data, SofaScore, etc.). This is per-source
 *      mapping data, NOT alias data — kept separate from entities
 *      because it's source-specific URL routing, not identity.
 *
 * No automatic AI is involved. Alias confirmations from settlement
 * paths flow through `recordObservation` with `source='settle'`, which
 * the promoter weights heavily because score-source matches are a
 * stronger truth signal than mere "two providers happened to match
 * fixtures at the same minute."
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { logger } from "../shared/logger";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  normalize as entityNormalize,
  recordObservation,
} from "../matching/entities";

const DATA_DIR = path.join(process.cwd(), "data", "aliases");
const SLUG_FILE = path.join(DATA_DIR, "competition-slugs.json");

// ─── Competition-slug store (source-specific URL routing) ────────────────

const SlugEntry = z.object({
  /** Normalized competition string from value_bets. */
  competition: z.string(),
  /** Which tier owns this slug — "espn", "football-data", "sofascore". */
  source: z.string(),
  slug: z.string(),
  addedAt: z.string(),
  occurrences: z.number().default(1),
});
const SlugFile = z.object({
  version: z.number(),
  updatedAt: z.string(),
  entries: z.array(SlugEntry),
});
type SlugFileT = z.infer<typeof SlugFile>;
type SlugEntryT = z.infer<typeof SlugEntry>;

let slugCache: Map<string, SlugEntryT> | null = null;

const cacheKey = (competition: string, source: string): string =>
  `${source}::${normalizeCompetition(competition)}`;

const ensureDir = (): void => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const loadSlugFile = (): SlugFileT => {
  if (!fs.existsSync(SLUG_FILE)) {
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
  try {
    const raw = fs.readFileSync(SLUG_FILE, "utf-8");
    return SlugFile.parse(JSON.parse(raw));
  } catch (err) {
    logger.warn(
      "SettleAliases",
      `Failed to read ${SLUG_FILE}: ${(err as Error).message}`,
    );
    return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
};

const saveSlugFile = (file: SlugFileT): void => {
  ensureDir();
  file.updatedAt = new Date().toISOString();
  fs.writeFileSync(SLUG_FILE, JSON.stringify(file, null, 2));
};

const ensureCache = (): Map<string, SlugEntryT> => {
  if (slugCache) return slugCache;
  const file = loadSlugFile();
  slugCache = new Map(
    file.entries.map((e) => [cacheKey(e.competition, e.source), e]),
  );
  return slugCache;
};

/**
 * Normalize a competition string for the slug-lookup table. Mirrors what
 * the ESPN/SofaScore adapters use so lookups hit consistently.
 */
export const normalizeCompetition = (raw: string | null): string =>
  (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const lookupCompetitionSlug = (
  competition: string | null,
  source: string,
): string | null => {
  const cache = ensureCache();
  const key = cacheKey(competition ?? "", source);
  return cache.get(key)?.slug ?? null;
};

export const learnCompetitionSlug = (
  competition: string | null,
  source: string,
  slug: string,
): void => {
  if (!competition || !slug) return;
  const norm = normalizeCompetition(competition);
  if (!norm) return;
  const file = loadSlugFile();
  const existing = file.entries.find(
    (e) => e.competition === norm && e.source === source,
  );
  if (existing) {
    existing.occurrences++;
    if (existing.slug !== slug) {
      logger.info(
        "SettleAliases",
        `Slug changed for "${norm}" on ${source}: ${existing.slug} → ${slug}`,
      );
      existing.slug = slug;
    }
  } else {
    file.entries.push({
      competition: norm,
      source,
      slug,
      addedAt: new Date().toISOString(),
      occurrences: 1,
    });
    logger.info("SettleAliases", `Learned: "${norm}" on ${source} → ${slug}`);
  }
  saveSlugFile(file);
  slugCache = null;
};

// ─── Team-name canonicalization (entity-resolver bridge) ─────────────────

/**
 * Sync team-name normalization used by the score-source matchers
 * (espn.ts, sofascore.ts) before they fuzzy-compare against scoreboard
 * data. Delegates to the entity-resolution normalizer, which handles
 * lowercase + NFD diacritic strip + Cyrillic/Greek/Vietnamese
 * transliteration + club-token strip in one pass.
 *
 * No DB lookup happens here — this is a pure function. Persistent
 * canonicalization is the entity-resolver's job and is consulted via
 * `learnTeamAlias` below when a settle pipeline confirms a name pair.
 */
export function applyTeamAlias(raw: string): string {
  return entityNormalize(raw);
}

/**
 * Record a confirmed team-name equivalence from a settlement source
 * match. Builds (or fetches) the canonical entity and writes a positive
 * observation. The promoter weights `source='settle'` heavily because
 * scoreboard sources are tied to actual match results — a much stronger
 * truth signal than provider-vs-provider fuzzy fixture matching.
 *
 * Two-arg overload kept for backwards-compatible callsites
 * (`learnTeamAlias(ourName, theirName)`); pass `provider` / `competition`
 * via the third options param when you have them.
 */
export async function learnTeamAlias(
  surfaceRaw: string,
  canonicalName: string,
  opts: { provider?: string; competition?: string | null } = {},
): Promise<void> {
  try {
    const compEntity = opts.competition
      ? await ensureCompetitionEntity(opts.competition)
      : null;
    const teamEntity = await ensureTeamEntity({
      canonicalName,
      competitionId: compEntity?.id ?? null,
    });
    if (!teamEntity) return;
    await recordObservation({
      kind: "team",
      surface: surfaceRaw,
      provider: opts.provider ?? "settle",
      competitionId: compEntity?.id ?? null,
      pairedWithEntityId: teamEntity.id,
      matchScore: 1,
      outcome: "matched",
      source: "settle",
    });
  } catch (err) {
    logger.warn(
      "SettleAliases",
      `learnTeamAlias failed: ${(err as Error).message}`,
    );
  }
}
