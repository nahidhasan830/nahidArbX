
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


const SlugEntry = z.object({
  competition: z.string(),
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


import { resolveTeamSurface } from "../matching/entities";

const canonicalCache = new Map<string, string>();

export async function preResolveTeams(
  names: string[],
  opts: { provider?: string; competitionRaw?: string | null } = {},
): Promise<void> {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return;

  let competitionId: string | null = null;
  if (opts.competitionRaw) {
    try {
      const compEntity = await ensureCompetitionEntity(opts.competitionRaw);
      competitionId = compEntity?.id ?? null;
    } catch {
    }
  }

  const provider = opts.provider ?? "settle";

  for (const name of unique) {
    const norm = entityNormalize(name);
    if (!norm || canonicalCache.has(norm)) continue;
    try {
      const resolved = await resolveTeamSurface({
        provider,
        surface: name,
        competitionId,
      });
      if (resolved?.entity?.canonicalName) {
        canonicalCache.set(norm, resolved.entity.canonicalName);
      }
    } catch {
    }
  }
}

export function clearCanonicalCache(): void {
  canonicalCache.clear();
}

export function applyTeamAlias(raw: string): string {
  const norm = entityNormalize(raw);
  return canonicalCache.get(norm) ?? norm;
}

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
