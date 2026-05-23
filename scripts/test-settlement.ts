/**
 * End-to-end settlement smoke test.
 *
 * Pulls a diverse sample of unsettled bets from the DB, runs them through
 * the waterfall (inlined here to avoid lib/db/client.ts's top-level await
 * that tsx's CJS transform can't handle) and reports tier hits, timing,
 * and outcome distribution.
 *
 * READ-ONLY by default. The DB only gets writes for freshly discovered
 * scores (via saveScoreIfAbsent) so subsequent runs hit Tier 0 for free.
 */

import { Pool } from "pg";
import { settleBet } from "../lib/settle/settle-bet";
import { fetchEspnScores } from "../lib/settle/sources/espn";
import { fetchSofaScoreScores } from "../lib/settle/sources/sofascore";
import type { ValueBetRow } from "../lib/bets-history/types";
import type { SettleEvent } from "../lib/settle/waterfall";
import type { MatchScore } from "../lib/settle/types";

const SAMPLE_SIZE = Number(process.argv[2] ?? 100);

// ── Pool ────────────────────────────────────────────────────────────────────

async function buildPool(): Promise<Pool> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const instance = process.env.CLOUD_SQL_INSTANCE;
  if (!instance) return new Pool({ connectionString, max: 3 });

  const { Connector, IpAddressTypes } =
    await import("@google-cloud/cloud-sql-connector");
  const url = new URL(connectionString);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = url.pathname.slice(1);
  const connector = new Connector();
  const clientOpts = await connector.getOptions({
    instanceConnectionName: instance,
    ipType: IpAddressTypes.PUBLIC,
  });
  return new Pool({ ...clientOpts, user, password, database, max: 3 });
}

// ── Stratified sample ───────────────────────────────────────────────────────

/** Sample N diverse ready-to-settle bets. */
async function sampleDiverseBets(
  pool: Pool,
  n: number,
): Promise<ValueBetRow[]> {
  const query = `
    WITH ready AS (
      SELECT *,
             row_number() OVER (
               PARTITION BY market_type, time_scope, split_part(atom_id, '_over_', 1)
               ORDER BY random()
             ) AS strat_rank
        FROM bets
       WHERE outcome = 'pending'
         AND event_start_time <= NOW() - INTERVAL '2 hours 15 minutes'
    )
    SELECT * FROM ready WHERE strat_rank <= 3
    ORDER BY random()
    LIMIT $1
  `;
  const { rows } = await pool.query(query, [n]);
  return rows.map(
    (r): ValueBetRow => ({
      id: r.id,
      eventId: r.event_id,
      familyId: r.family_id,
      atomId: r.atom_id,
      atomLabel: r.atom_label,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      competition: r.competition,
      eventStartTime:
        r.event_start_time instanceof Date
          ? r.event_start_time.toISOString()
          : r.event_start_time,
      marketType: r.market_type,
      timeScope: r.time_scope,
      familyLine: r.family_line,
      sharpProvider: r.sharp_provider,
      sharpOdds: Number(r.sharp_odds),
      sharpTrueProb: Number(r.sharp_true_prob),
      softProvider: r.soft_provider,
      softCommissionPct: Number(r.soft_commission_pct),
      softOdds: Number(r.soft_odds),
      firstSeenAt:
        r.first_seen_at instanceof Date
          ? r.first_seen_at.toISOString()
          : r.first_seen_at,
      lastSeenAt:
        r.last_seen_at instanceof Date
          ? r.last_seen_at.toISOString()
          : r.last_seen_at,
      tickCount: r.tick_count,
      closingSharpOdds:
        r.closing_sharp_odds == null ? null : Number(r.closing_sharp_odds),
      outcome: r.outcome,
      settledBySource: r.settled_by_source ?? null,
      settledAt:
        r.settled_at instanceof Date
          ? r.settled_at.toISOString()
          : (r.settled_at ?? null),
      settleAttempts: r.settle_attempts ?? 0,
      lastSettleAttemptAt:
        r.last_settle_attempt_at instanceof Date
          ? r.last_settle_attempt_at.toISOString()
          : (r.last_settle_attempt_at ?? null),
    }),
  );
}

// ── Tier 0: cache read ──────────────────────────────────────────────────────

async function readCache(
  pool: Pool,
  eventIds: string[],
): Promise<Map<string, MatchScore>> {
  const out = new Map<string, MatchScore>();
  if (eventIds.length === 0) return out;
  const { rows } = await pool.query<{
    event_id: string;
    status: string;
    ht_home: number | null;
    ht_away: number | null;
    ft_home: number;
    ft_away: number;
    et_home: number | null;
    et_away: number | null;
    pen_home: number | null;
    pen_away: number | null;
    corners_home: number | null;
    corners_away: number | null;
    ht_corners_home: number | null;
    ht_corners_away: number | null;
    source: string;
    confidence: string;
    source_url: string | null;
    fetched_at: Date;
  }>(`SELECT * FROM match_scores WHERE event_id = ANY($1::text[])`, [eventIds]);
  for (const r of rows) {
    out.set(r.event_id, {
      eventId: r.event_id,
      status: r.status as MatchScore["status"],
      htHome: r.ht_home,
      htAway: r.ht_away,
      ftHome: r.ft_home,
      ftAway: r.ft_away,
      etHome: r.et_home,
      etAway: r.et_away,
      penHome: r.pen_home,
      penAway: r.pen_away,
      cornersHome: r.corners_home,
      cornersAway: r.corners_away,
      htCornersHome: r.ht_corners_home,
      htCornersAway: r.ht_corners_away,
      source: r.source as MatchScore["source"],
      confidence: Number(r.confidence),
      sourceUrl: r.source_url,
      fetchedAt: r.fetched_at.toISOString(),
    });
  }
  return out;
}

async function persistScore(pool: Pool, s: MatchScore): Promise<void> {
  // Upsert: if the row already exists, overwrite fields that may have
  // been enriched (e.g. corners we didn't have on a prior run).
  await pool.query(
    `INSERT INTO match_scores (
      event_id, status, ht_home, ht_away, ft_home, ft_away,
      et_home, et_away, pen_home, pen_away,
      corners_home, corners_away, ht_corners_home, ht_corners_away,
      source, confidence, source_url
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (event_id) DO UPDATE SET
      ht_home = EXCLUDED.ht_home,
      ht_away = EXCLUDED.ht_away,
      corners_home = COALESCE(EXCLUDED.corners_home, match_scores.corners_home),
      corners_away = COALESCE(EXCLUDED.corners_away, match_scores.corners_away),
      ht_corners_home = COALESCE(EXCLUDED.ht_corners_home, match_scores.ht_corners_home),
      ht_corners_away = COALESCE(EXCLUDED.ht_corners_away, match_scores.ht_corners_away)`,
    [
      s.eventId,
      s.status,
      s.htHome,
      s.htAway,
      s.ftHome,
      s.ftAway,
      s.etHome ?? null,
      s.etAway ?? null,
      s.penHome ?? null,
      s.penAway ?? null,
      s.cornersHome ?? null,
      s.cornersAway ?? null,
      s.htCornersHome ?? null,
      s.htCornersAway ?? null,
      s.source,
      s.confidence,
      s.sourceUrl ?? null,
    ],
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const bar = (n: number, max: number, width = 24): string => {
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
};

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = await buildPool();

  // Idempotent bootstrap: make sure corners columns exist. Cheap, safe
  // if already applied. Saves us from a separate slow migration script.
  await pool.query(
    `ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "corners_home"    integer`,
  );
  await pool.query(
    `ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "corners_away"    integer`,
  );
  await pool.query(
    `ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "ht_corners_home" integer`,
  );
  await pool.query(
    `ALTER TABLE "match_scores" ADD COLUMN IF NOT EXISTS "ht_corners_away" integer`,
  );

  console.log(`\n── Settlement waterfall e2e test (${SAMPLE_SIZE} bets) ──\n`);

  const sampleStart = Date.now();
  const bets = await sampleDiverseBets(pool, SAMPLE_SIZE);
  const sampleMs = Date.now() - sampleStart;
  if (bets.length === 0) {
    console.log("No ready-to-settle bets found in DB.");
    await pool.end();
    return;
  }

  const buckets = new Map<string, number>();
  for (const b of bets) {
    const k = `${b.marketType} / ${b.timeScope}`;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const events: SettleEvent[] = [];
  const eventSet = new Set<string>();
  for (const b of bets) {
    if (!eventSet.has(b.eventId)) {
      eventSet.add(b.eventId);
      events.push({
        eventId: b.eventId,
        homeTeam: b.homeTeam,
        awayTeam: b.awayTeam,
        competition: b.competition,
        startTime: b.eventStartTime,
      });
    }
  }

  console.log(
    `Sampled ${bets.length} bets across ${events.length} unique events in ${sampleMs}ms.\n`,
  );
  console.log("Sample composition (market / scope):");
  for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${k.padEnd(28)} ${String(v).padStart(3)}  ${bar(v, bets.length)}`,
    );
  }

  const tierHits = { t0: 0, t1: 0, t2: 0, unresolved: 0 };
  const scores = new Map<string, MatchScore>();
  const perTierMs = { t0: 0, t2: 0 };

  const needsCornersSample = bets.some(
    (b) =>
      b.marketType === "CORNERS" ||
      b.marketType === "HOME_CORNERS_TOTAL" ||
      b.marketType === "AWAY_CORNERS_TOTAL" ||
      b.marketType === "CORNERS_HANDICAP" ||
      b.marketType === "CORNERS_EUROPEAN_HANDICAP",
  );

  // Tier 0: cache (bypass stats-less rows when a corners bet is in batch)
  const t0Start = Date.now();
  const cached = await readCache(pool, [...eventSet]);
  for (const [id, s] of cached) {
    const cornersRequiredButMissing =
      needsCornersSample && (s.cornersHome == null || s.cornersAway == null);
    if (cornersRequiredButMissing) continue;
    scores.set(id, s);
    tierHits.t0++;
  }
  perTierMs.t0 = Date.now() - t0Start;

  // Tier 1: skip — live feed not running in this standalone script

  // Tier 2a: ESPN (broadest free coverage)
  const tierHitsEspn = { count: 0 };
  const missingAfterT1 = events.filter((e) => !scores.has(e.eventId));
  const t2Start = Date.now();
  if (missingAfterT1.length > 0) {
    try {
      const t2espn = await fetchEspnScores(missingAfterT1);
      for (const [id, s] of t2espn) {
        if (s.confidence >= 0.7) {
          scores.set(id, s);
          tierHits.t2++;
          tierHitsEspn.count++;
          await persistScore(pool, s);
        }
      }
    } catch (err) {
      console.log(`  Tier 2a (ESPN) error: ${(err as Error).message}`);
    }
  }

  // Tier 2b: SofaScore — request corner stats only if any bet needs them.
  const tierHitsSofa = { count: 0 };
  const needsCorners = bets.some(
    (b) =>
      b.marketType === "CORNERS" ||
      b.marketType === "HOME_CORNERS_TOTAL" ||
      b.marketType === "AWAY_CORNERS_TOTAL" ||
      b.marketType === "CORNERS_HANDICAP" ||
      b.marketType === "CORNERS_EUROPEAN_HANDICAP",
  );
  const missingAfterEspn = events.filter((e) => !scores.has(e.eventId));
  if (missingAfterEspn.length > 0) {
    try {
      const t2sofa = await fetchSofaScoreScores(missingAfterEspn, {
        withCorners: needsCorners,
      });
      for (const [id, s] of t2sofa) {
        if (s.confidence >= 0.7) {
          scores.set(id, s);
          tierHits.t2++;
          tierHitsSofa.count++;
          await persistScore(pool, s);
        }
      }
    } catch (err) {
      console.log(`  Tier 2b (SofaScore) error: ${(err as Error).message}`);
    }
  }

  // Corner-enrichment pass: for events resolved by a non-stats tier
  // (ESPN, football-data), fetch corners via SofaScore and merge.
  if (needsCorners) {
    const needEnrichment = events.filter((e) => {
      const s = scores.get(e.eventId);
      return s && (s.cornersHome == null || s.cornersAway == null);
    });
    if (needEnrichment.length > 0) {
      try {
        const enriched = await fetchSofaScoreScores(needEnrichment, {
          withCorners: true,
        });
        for (const [id, s] of enriched) {
          if (s.cornersHome == null || s.cornersAway == null) continue;
          const existing = scores.get(id);
          if (!existing) continue;
          const merged: MatchScore = {
            ...existing,
            cornersHome: s.cornersHome,
            cornersAway: s.cornersAway,
            htCornersHome: s.htCornersHome ?? existing.htCornersHome ?? null,
            htCornersAway: s.htCornersAway ?? existing.htCornersAway ?? null,
          };
          scores.set(id, merged);
          await persistScore(pool, merged);
        }
      } catch (err) {
        console.log(`  Corner enrichment error: ${(err as Error).message}`);
      }
    }
  }
  perTierMs.t2 = Date.now() - t2Start;

  tierHits.unresolved = events.length - scores.size;

  console.log("\nTier hits (events resolved):");
  const total = events.length;
  for (const [label, count] of [
    ["T0 cache (match_scores)  ", tierHits.t0],
    ["T1 live feed (skipped)   ", 0],
    ["T2a ESPN                 ", tierHitsEspn.count],
    ["T2b SofaScore            ", tierHitsSofa.count],
    ["unresolved               ", tierHits.unresolved],
  ] as const) {
    console.log(
      `  ${label} ${String(count).padStart(3)}/${total}  ${bar(count, total)}`,
    );
  }

  // Deterministic settle per bet
  const settleStart = Date.now();
  const outcomeCounts: Record<string, number> = {
    won: 0,
    lost: 0,
    half_won: 0,
    half_lost: 0,
    void: 0,
    pending: 0,
  };
  const reasonCounts = new Map<string, number>();
  const unresolvedByMarket = new Map<string, number>();
  const pendingExamples: string[] = [];
  for (const b of bets) {
    const score = scores.get(b.eventId);
    if (!score) {
      outcomeCounts.pending++;
      reasonCounts.set(
        "no-score-resolved",
        (reasonCounts.get("no-score-resolved") ?? 0) + 1,
      );
      const k = `${b.marketType}/${b.timeScope}`;
      unresolvedByMarket.set(k, (unresolvedByMarket.get(k) ?? 0) + 1);
      if (pendingExamples.length < 15) {
        pendingExamples.push(
          `${b.homeTeam} vs ${b.awayTeam} (${b.competition ?? "-"}) @ ${b.eventStartTime.slice(0, 16)}  [${b.marketType}/${b.timeScope}]`,
        );
      }
      continue;
    }
    const r = settleBet(b, score);
    outcomeCounts[r.outcome] = (outcomeCounts[r.outcome] ?? 0) + 1;
    reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1);
    if (r.outcome === "pending") {
      const k = `${b.marketType}/${b.timeScope}`;
      unresolvedByMarket.set(k, (unresolvedByMarket.get(k) ?? 0) + 1);
    }
  }
  const settleMs = Date.now() - settleStart;

  console.log(`\nDeterministic settle ran in ${settleMs}ms.`);
  console.log("\nOutcome distribution:");
  for (const [k, v] of Object.entries(outcomeCounts)) {
    console.log(
      `  ${k.padEnd(10)}  ${String(v).padStart(3)}  ${bar(v, bets.length)}`,
    );
  }
  console.log("\nReason codes:");
  for (const [k, v] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${String(v).padStart(3)}`);
  }
  if (unresolvedByMarket.size > 0) {
    console.log("\nUnresolved by market/scope:");
    for (const [k, v] of [...unresolvedByMarket].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(24)} ${String(v).padStart(3)}`);
    }
  }
  if (pendingExamples.length > 0) {
    console.log(
      `\nExamples of unresolved events (first ${pendingExamples.length}):`,
    );
    for (const e of pendingExamples) console.log(`  • ${e}`);
  }

  console.log("\n── Timing ──");
  console.log(`  Sampling:   ${sampleMs}ms`);
  console.log(`  Tier 0:     ${perTierMs.t0}ms`);
  console.log(`  Tier 2:     ${perTierMs.t2}ms`);
  console.log(`  Settle:     ${settleMs}ms`);
  const total_ms = sampleMs + perTierMs.t0 + perTierMs.t2 + settleMs;
  console.log(
    `  Total:      ${total_ms}ms (${(total_ms / bets.length).toFixed(1)}ms/bet)`,
  );

  console.log("\n── Summary ──");
  const settled = bets.length - (outcomeCounts.pending ?? 0);
  console.log(`  Bets scanned:  ${bets.length}`);
  console.log(
    `  Bets settled:  ${settled} (${((settled / bets.length) * 100).toFixed(1)}%)`,
  );
  console.log(`  Bets pending:  ${outcomeCounts.pending ?? 0}`);
  console.log(
    `  Events resolved: ${total - tierHits.unresolved}/${total} ` +
      `(${(((total - tierHits.unresolved) / total) * 100).toFixed(1)}%)`,
  );

  // Cloud SQL connector can take ~30s to close sockets cleanly;
  // force-exit once we've printed the report to keep iteration fast.
  pool.end().catch(() => undefined);
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error("test-settlement failed:", err);
  process.exit(1);
});
