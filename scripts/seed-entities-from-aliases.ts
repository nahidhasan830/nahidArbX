/**
 * One-shot import: convert the legacy JSON alias store into the new
 * entity-resolution Postgres tables.
 *
 * Reads:
 *   - data/aliases/team-aliases.json
 *   - data/aliases/competition-aliases.json
 *
 * Writes:
 *   - entities (one row per distinct canonical name)
 *   - entity_names (one row per source surface, status='active', weight
 *     primed from `occurrences`)
 *   - name_observations (a single seed-import row per surface, source='seed')
 *
 * Drops with logging:
 *   - Aliases with >5 word canonicals (likely concatenation bugs — the
 *     audit found 9 of these)
 *   - Aliases the operator has flagged as known-bad in MANUAL_DROP
 *
 * Idempotent — safe to re-run.
 *
 * Usage: `npx tsx scripts/seed-entities-from-aliases.ts`
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { Connector, IpAddressTypes } from "@google-cloud/cloud-sql-connector";

// Manually-flagged junk aliases the operator has identified — these survived
// the harvester's gates but are known wrong (different teams glued together).
// Add to this list as you discover more; re-running the script drops them.
const MANUAL_DROP_TEAM_SOURCES = new Set<string>([
  "obolon", // → "obolon kyiv metalurh donetsk" — two unrelated UA clubs
  "sc poltava", // → "fc polissya zhytomyr" — different teams
  "ho chi minh city", // → "công an hồ chí minh city" — different clubs
  "incheon hyundai steel red angels", // gender mixup
]);

const MANUAL_DROP_COMP_SOURCES = new Set<string>([]);

interface AliasEntry {
  source: string;
  canonical: string;
  addedAt: string;
  addedBy?: string;
  autoLearned: boolean;
  occurrences: number;
}

interface AliasFile {
  version: number;
  updatedAt: string;
  aliases: AliasEntry[];
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "_"
  );
}

function basicNormalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWomensTeam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("(wom") ||
    lower.includes("(w)") ||
    /\bwomen\b/.test(lower) ||
    /\bwomens\b/.test(lower) ||
    /\bw\s/.test(lower) ||
    /\bw$/.test(lower) ||
    lower.includes("ladies") ||
    lower.includes("femenino") ||
    lower.includes("femeni") ||
    lower.includes("feminino") ||
    lower.includes("frauen") ||
    lower.includes("dames") ||
    lower.includes("vrouwen")
  );
}

function buildEntityId(input: {
  kind: "team" | "competition";
  canonicalName: string;
  gender?: string | null;
}): string {
  const gender = input.gender ?? "_";
  return `${input.kind}|_|${gender}|${slugify(input.canonicalName)}`;
}

async function buildPool(): Promise<Pool> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) {
    return new Pool({ connectionString: url, max: 4 });
  }
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.slice(1);
  const connector = new Connector();
  const opts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  const cfg: PoolConfig = { ...opts, user, password, database, max: 4 };
  return new Pool(cfg);
}

async function importTeams(pool: Pool, file: AliasFile): Promise<void> {
  let dropped = 0;
  let imported = 0;
  let entitiesCreated = 0;
  // Cache canonical → entity_id so duplicates re-use rows.
  const entityIdCache = new Map<string, string>();

  for (const alias of file.aliases) {
    const sourceLower = alias.source.toLowerCase();
    if (MANUAL_DROP_TEAM_SOURCES.has(sourceLower)) {
      dropped++;
      console.log(`  drop[manual]: "${alias.source}" -> "${alias.canonical}"`);
      continue;
    }
    if (alias.canonical.split(/\s+/).length > 5) {
      dropped++;
      console.log(
        `  drop[junk-long]: "${alias.source}" -> "${alias.canonical}"`,
      );
      continue;
    }
    if (isWomensTeam(alias.source) !== isWomensTeam(alias.canonical)) {
      dropped++;
      console.log(`  drop[gender]: "${alias.source}" -> "${alias.canonical}"`);
      continue;
    }

    const gender = isWomensTeam(alias.canonical) ? "f" : "m";
    let entityId = entityIdCache.get(`team|${gender}|${alias.canonical}`);
    if (!entityId) {
      entityId = buildEntityId({
        kind: "team",
        canonicalName: alias.canonical,
        gender,
      });
      await pool.query(
        `INSERT INTO entities (id, kind, canonical_name, gender, metadata)
            VALUES ($1, 'team', $2, $3, '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [entityId, alias.canonical, gender],
      );
      entityIdCache.set(`team|${gender}|${alias.canonical}`, entityId);
      entitiesCreated++;
    }

    // Insert TWO entity_names rows: one for the source surface, one for
    // the canonical. Both bound to the same entity. provider='seed' since
    // we don't know which provider the historical alias came from.
    const insertName = async (raw: string) => {
      const norm = basicNormalize(raw);
      if (!norm || norm.length < 2) return;
      const id = randomUUID();
      await pool.query(
        `INSERT INTO entity_names
           (id, entity_id, competition_id, provider, surface_raw,
            surface_normalized, weight, positive_obs, negative_obs,
            status, first_seen_at, last_seen_at, promoted_at)
         VALUES ($1, $2, NULL, 'seed', $3, $4, $5, $6, 0, 'active', $7, NOW(), NOW())
         ON CONFLICT (provider, surface_normalized, competition_id) DO NOTHING`,
        [
          id,
          entityId,
          raw,
          norm,
          Math.max(alias.occurrences, 1),
          alias.occurrences,
          alias.addedAt,
        ],
      );
    };
    await insertName(alias.source);
    await insertName(alias.canonical);

    // Seed observation
    await pool.query(
      `INSERT INTO name_observations
         (surface_raw, surface_normalized, competition_id, provider,
          paired_with_entity_id, match_score, outcome, source, metadata)
       VALUES ($1, $2, NULL, 'seed', $3, NULL, 'manual-confirm', 'seed',
               jsonb_build_object('legacy_addedBy', $4::text, 'occurrences', $5::int))`,
      [
        alias.source,
        basicNormalize(alias.source),
        entityId,
        alias.addedBy ?? "unknown",
        alias.occurrences,
      ],
    );
    imported++;
  }
  console.log(
    `Teams: imported ${imported} aliases (${entitiesCreated} new entities), dropped ${dropped}`,
  );
}

async function importCompetitions(pool: Pool, file: AliasFile): Promise<void> {
  let dropped = 0;
  let imported = 0;
  let entitiesCreated = 0;
  const entityIdCache = new Map<string, string>();

  for (const alias of file.aliases) {
    const sourceLower = alias.source.toLowerCase();
    if (MANUAL_DROP_COMP_SOURCES.has(sourceLower)) {
      dropped++;
      continue;
    }
    if (alias.canonical.split(/\s+/).length > 7) {
      dropped++;
      console.log(
        `  drop[junk-long]: "${alias.source}" -> "${alias.canonical}"`,
      );
      continue;
    }

    let entityId = entityIdCache.get(`competition|_|${alias.canonical}`);
    if (!entityId) {
      entityId = buildEntityId({
        kind: "competition",
        canonicalName: alias.canonical,
      });
      await pool.query(
        `INSERT INTO entities (id, kind, canonical_name, metadata)
            VALUES ($1, 'competition', $2, '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [entityId, alias.canonical],
      );
      entityIdCache.set(`competition|_|${alias.canonical}`, entityId);
      entitiesCreated++;
    }

    const insertName = async (raw: string) => {
      const norm = basicNormalize(raw);
      if (!norm || norm.length < 2) return;
      const id = randomUUID();
      await pool.query(
        `INSERT INTO entity_names
           (id, entity_id, competition_id, provider, surface_raw,
            surface_normalized, weight, positive_obs, negative_obs,
            status, first_seen_at, last_seen_at, promoted_at)
         VALUES ($1, $2, NULL, 'seed', $3, $4, $5, $6, 0, 'active', $7, NOW(), NOW())
         ON CONFLICT (provider, surface_normalized, competition_id) DO NOTHING`,
        [
          id,
          entityId,
          raw,
          norm,
          Math.max(alias.occurrences, 1),
          alias.occurrences,
          alias.addedAt,
        ],
      );
    };
    await insertName(alias.source);
    await insertName(alias.canonical);
    imported++;
  }
  console.log(
    `Competitions: imported ${imported} aliases (${entitiesCreated} new entities), dropped ${dropped}`,
  );
}

async function main(): Promise<void> {
  const teamFilePath = join(
    process.cwd(),
    "data",
    "aliases",
    "team-aliases.json",
  );
  const compFilePath = join(
    process.cwd(),
    "data",
    "aliases",
    "competition-aliases.json",
  );

  if (!existsSync(teamFilePath) && !existsSync(compFilePath)) {
    console.log(
      "No JSON alias files present — skipping import (probably already deleted).",
    );
    return;
  }

  const pool = await buildPool();
  console.log("Seeding entities table from legacy JSON aliases…");

  if (existsSync(teamFilePath)) {
    const teamFile: AliasFile = JSON.parse(readFileSync(teamFilePath, "utf-8"));
    await importTeams(pool, teamFile);
  }

  if (existsSync(compFilePath)) {
    const compFile: AliasFile = JSON.parse(readFileSync(compFilePath, "utf-8"));
    await importCompetitions(pool, compFile);
  }

  await pool.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
