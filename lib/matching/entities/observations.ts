/**
 * Observation ingress — the SINGLE entry point for every alias-learning
 * writer in the system. Replaces the four scattered `addTeamAlias` /
 * `addCompetitionAlias` callsites that used to write directly to JSON.
 *
 * Every match attempt — successful, near-miss, rejected, manual-confirm,
 * manual-reject — flows through `recordObservation`. The function:
 *
 *   1. Appends to `name_observations` (always — append-only audit log).
 *   2. Upserts the matching `entity_names` candidate row, incrementing
 *      `positive_obs` / `negative_obs` and `weight` based on outcome and
 *      provider trust.
 *   3. Returns. Never blocks the sync hot path on promotion logic — the
 *      promoter background tick judges candidates separately every 5min.
 *
 * The promoter is what decides if/when a candidate becomes `active`.
 */

import { logger } from "../../shared/logger";
import {
  buildEntityId,
  type EntityKind,
  type ObservationOutcome,
  type ObservationSource,
  insertObservation,
  upsertEntity,
  upsertEntityName,
  updateNameAfterObservation,
  getEntityById,
  getEntityNameById,
  type EntityRow,
} from "../../db/repositories/entities";
import {
  gendersDiffer,
  normalize,
  normalizeCompetition,
  teamVariantTag,
} from "./normalize";
import { autoResolve } from "./auto-resolve";
import { getProviderObservationWeight } from "../../providers/registry";

const tag = "EntityObs";

// ── Provider trust weights ──────────────────────────────────────────────
//
// Multiplier applied to weight on positive observations. Pinnacle is the
// sharp benchmark; settle observations get a high weight because they
// piggy-back on score-source matches (a stronger truth signal than mere
// "two providers had the same fixture at the same minute").
const SOURCE_WEIGHT_MULTIPLIER: Record<ObservationSource, number> = {
  "match-review": 4, // operator confirm = high trust
  learner: 2,
  settle: 4, // settlement-derived = high trust (score data is ground truth)
  harvester: 1,
};

function providerWeight(provider: string): number {
  return getProviderObservationWeight(provider);
}

// ─── Public API ────────────────────────────────────────────────────────

export interface RecordObservationInput {
  /** Entity kind: 'team' or 'competition'. */
  kind: EntityKind;
  /** Raw surface name as it appeared in the provider data. */
  surface: string;
  /** Provider key (pinnacle, ninewickets-exchange, ...). */
  provider: string;
  /** Competition entity id this observation is scoped to (NULL for global / competition itself). */
  competitionId: string | null;
  /**
   * The entity this surface was paired with. NULL only when the resolver
   * couldn't find any candidate (so we record an orphan observation that
   * the promoter will eventually surface to the operator review queue).
   */
  pairedWithEntityId: string | null;
  /** Matcher's confidence (0–1) at the time of the observation. */
  matchScore: number | null;
  /** Latest classifier prediction (0–1), if Tier-2 ML scored this pair. */
  classifierScore?: number | null;
  /** What did the matcher / operator decide? */
  outcome: ObservationOutcome;
  /** Which subsystem ingested this observation (for provenance). */
  source: ObservationSource;
  /** Free-form metadata — provider event id, opponent name, etc. */
  metadata?: Record<string, unknown>;
}

/**
 * Record one observation. Appends to the audit log AND updates the
 * candidate row counters. Never throws on user-facing paths — failures
 * are logged and swallowed so a Postgres hiccup can't break matching.
 */
export async function recordObservation(
  input: RecordObservationInput,
): Promise<void> {
  try {
    const surfaceNormalized =
      input.kind === "competition"
        ? normalizeCompetition(input.surface)
        : normalize(input.surface);

    if (!surfaceNormalized || surfaceNormalized.length < 2) return;

    // 1. Append-only audit row.
    await insertObservation({
      surfaceRaw: input.surface,
      surfaceNormalized,
      competitionId: input.competitionId,
      provider: input.provider,
      pairedWithEntityId: input.pairedWithEntityId,
      matchScore: input.matchScore,
      classifierScore: input.classifierScore ?? null,
      outcome: input.outcome,
      source: input.source,
      metadata: input.metadata ?? {},
    });

    // 2. If we don't have an entity to bind to, we're done. The orphan
    //    observation will get surfaced via the review queue.
    if (!input.pairedWithEntityId) return;

    // 3. Upsert the candidate row and apply evidence delta.
    const candidate = await upsertEntityName({
      entityId: input.pairedWithEntityId,
      competitionId: input.competitionId,
      provider: input.provider,
      surfaceRaw: input.surface,
      surfaceNormalized,
      status: "candidate",
    });

    // Detect entity binding conflict: existing row points to a different
    // entity than what this observation paired with. This happens when the
    // same surface was first seen in a different context (e.g. men's vs
    // women's). Log and skip — don't pollute the wrong entity's counters.
    if (candidate.entityId !== input.pairedWithEntityId) {
      logger.info(
        tag,
        `Binding conflict: "${input.surface}" (${input.provider}) already bound to ` +
          `${candidate.entityId}, observation paired with ${input.pairedWithEntityId} — skipping`,
      );
      return;
    }

    const isPositive =
      input.outcome === "matched" || input.outcome === "manual-confirm";
    const isNegative =
      input.outcome === "rejected" || input.outcome === "manual-reject";

    if (isPositive) {
      const w =
        providerWeight(input.provider) * SOURCE_WEIGHT_MULTIPLIER[input.source];
      await updateNameAfterObservation(candidate.id, {
        positiveObsDelta: 1,
        weightDelta: w,
        classifierScore: input.classifierScore ?? undefined,
      });
    } else if (isNegative) {
      await updateNameAfterObservation(candidate.id, {
        negativeObsDelta: 1,
        classifierScore: input.classifierScore ?? undefined,
      });
    } else {
      // 'near-match' just bumps last_seen so the auto-resolver still gets
      // a chance to look at the candidate; contributes no positive /
      // negative evidence on its own.
      await updateNameAfterObservation(candidate.id, {
        classifierScore: input.classifierScore ?? undefined,
      });
    }

    // 4. Fire-and-forget auto-resolution.
    //
    // We refetch the row by id (the in-memory `candidate` is from BEFORE
    // updateNameAfterObservation, so its counters are stale). The whole
    // call is intentionally NOT awaited — the sync hot path returns
    // immediately and the resolver verdict (status flip + cache invalidation
    // via LISTEN/NOTIFY) lands ~150–250 ms later. New aliases become
    // effective on the next sync tick, which is the right trade-off between
    // correctness and sync latency.
    //
    // Skip for 'near-match' — those are weak observations that shouldn't
    // trigger auto-confirm by themselves; let a later positive observation
    // drive the verdict instead.
    if (isPositive || isNegative) {
      void runAutoResolveBackground(candidate.id);
    }
  } catch (err) {
    logger.warn(
      tag,
      `recordObservation failed: ${(err as Error).message} (${input.kind} "${input.surface}" via ${input.source})`,
    );
  }
}

// ─── Convenience helpers ──────────────────────────────────────────────

/**
 * Look up a competition entity by name; create one as `active` if it
 * doesn't exist yet. Used by the matcher during pre-normalization to
 * resolve the competition_id needed for team observations.
 *
 * Competitions have a much smaller universe than teams (~5k known) so
 * we treat them as eagerly-created (no candidate phase). The promoter
 * still surfaces conflicts via observations if two competitions
 * collide on the same surface.
 */
export async function ensureCompetitionEntity(
  rawCompetition: string,
): Promise<EntityRow | null> {
  const trimmed = rawCompetition.trim();
  if (!trimmed) return null;

  const canonical = trimmed; // store the human-readable form
  const id = buildEntityId({ kind: "competition", canonicalName: canonical });
  const existing = await getEntityById(id);
  if (existing) return existing;
  return upsertEntity({ kind: "competition", canonicalName: canonical });
}

/**
 * Look up or create a team entity by canonical name. Returned entity is
 * what `pairedWithEntityId` should reference in subsequent observations.
 * The team identity is keyed by canonical+gender so men's "Athletic" and
 * women's "Athletic" never collapse.
 */
export async function ensureTeamEntity(opts: {
  canonicalName: string;
  competitionId?: string | null;
}): Promise<EntityRow | null> {
  const trimmed = opts.canonicalName.trim();
  if (!trimmed) return null;
  const gender = /\bwomen\b|\(w\)|\(wom/i.test(trimmed) ? "f" : "m";
  // The variant tag (u20 / olympic / futsal / reserves / etc.) is part
  // of the entity's identity — "Brazil" and "Brazil U20" must end up as
  // distinct entities so the lookup never confuses them. Encoding it
  // into buildEntityId via the metadata-suffixed canonical guarantees
  // the IDs differ even if every other field collides.
  const variant = teamVariantTag(trimmed);
  return upsertEntity({
    kind: "team",
    canonicalName: trimmed,
    gender,
    parentId: opts.competitionId ?? null,
    metadata: variant ? { variant } : {},
  });
}

export { gendersDiffer };

/**
 * Fire-and-forget auto-resolve runner. Refetches the candidate row
 * (counters were stale in the in-memory copy that triggered this call)
 * and runs the staged auto-resolver. All errors are logged and swallowed
 * — this is background work; the caller has already returned.
 */
async function runAutoResolveBackground(candidateId: string): Promise<void> {
  try {
    const refreshed = await getEntityNameById(candidateId);
    if (!refreshed) return;
    if (refreshed.status !== "candidate") return; // already decided
    await autoResolve({ candidate: refreshed });
  } catch (err) {
    logger.warn(
      tag,
      `runAutoResolveBackground failed: ${(err as Error).message}`,
    );
  }
}
