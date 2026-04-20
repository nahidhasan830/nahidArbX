/**
 * Settlement-specific alias helpers.
 *
 * Two concerns on top of the existing event-matching alias store
 * (`lib/matching/aliases/store.ts`, which is designed for provider-to-
 * provider team matching):
 *
 *   1. A thin wrapper that consults the existing team alias store before
 *      we run fuzzy matching. If we've previously confirmed "Werder
 *      Bremen" corresponds to "SV Werder Bremen" on a score source, we
 *      can skip the similarity scoring next time.
 *
 *   2. A brand-new `competition_slugs.json` store that maps the raw
 *      `competition` string we see on value_bets to the slug a given
 *      score source uses. Built incrementally as the pipeline resolves
 *      events — first pass hits hand-coded aliases, subsequent passes
 *      add learned mappings so the coverage graph expands over time.
 *
 * No AI is required for this file. Learning happens organically as the
 * pipeline confirms matches; AI-assisted learning can layer on top by
 * calling `learnCompetitionSlug`/`addTeamAlias` with a verdict from
 * Gemini if/when the kill switch is flipped on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { addTeamAlias, getTeamAliases } from "../matching/aliases/store";
import { logger } from "../shared/logger";

const DATA_DIR = path.join(process.cwd(), "data", "aliases");
const SLUG_FILE = path.join(DATA_DIR, "competition-slugs.json");

// ─── Competition-slug store ─────────────────────────────────────────────────

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
 * Normalize a competition string to a stable form. Mirrors the logic
 * ESPN/SofaScore adapters use so lookups hit consistently.
 */
export const normalizeCompetition = (raw: string | null): string =>
  (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Lookup the learned slug for a given (competition, source). Returns
 * `null` if no alias has been learned yet — caller should fall back to
 * its hand-coded table.
 */
export const lookupCompetitionSlug = (
  competition: string | null,
  source: string,
): string | null => {
  const cache = ensureCache();
  const key = cacheKey(competition ?? "", source);
  return cache.get(key)?.slug ?? null;
};

/**
 * Persist a newly-discovered competition → slug mapping. Called by an
 * adapter once it successfully resolves events for that slug; subsequent
 * runs skip the slug-lookup table and go straight to the learned entry.
 */
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
  slugCache = null; // invalidate
};

// ─── Team alias helpers (reusing existing store) ─────────────────────────────

/**
 * Apply learned team aliases before similarity scoring. Returns the
 * canonical form if one has been stored, or the input unchanged.
 */
export const applyTeamAlias = (raw: string): string => {
  const table = getTeamAliases();
  const lower = raw.toLowerCase().trim();
  return table[lower] ?? lower;
};

/**
 * Record a newly-confirmed team-name equivalence. Delegates to the
 * existing store so admin UIs see learned entries uniformly.
 */
export const learnTeamAlias = (source: string, canonical: string): void => {
  addTeamAlias(source, canonical, { autoLearned: true, addedBy: "settle" });
};
