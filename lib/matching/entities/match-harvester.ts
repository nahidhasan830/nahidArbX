/**
 * Adapter that bridges the matcher's "two providers just merged" event
 * into the entity-resolution observation pipeline.
 *
 * Replaces the legacy `lib/matching/aliases/harvester.ts` harvester +
 * staging file system. The mental model shift:
 *
 *   OLD: every match pair adds a name pair to a JSON staging file.
 *        After 3 occurrences, the alias is permanent.
 *
 *   NEW: every match pair calls `recordObservation` once per side. The
 *        promoter background tick judges candidates via Tier 0/1/2,
 *        with conflict-detection and decay.
 *
 * No more "min occurrences threshold" — the Bayesian-flavoured evidence
 * formula in the promoter handles base rate + provider trust + temporal
 * spread cleanly.
 */

import type { NormalizedEvent } from "../../types";
import type { PreNormalizedNames } from "../normalize";
import { resolveCompetitionSurface } from "./resolver";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "./observations";
import type { ObservationSource } from "../../db/repositories/entities";
import { logger } from "../../shared/logger";

const tag = "MatchHarvester";

/**
 * Called from `matcher.findMatchesInGroup()` after a pair has been
 * confirmed (score ≥ MATCH_THRESHOLD). Records two team observations
 * and one competition observation per pair, all bound to the entity
 * the matcher believes best represents the pair.
 *
 * Pinnacle is the canonical-source heuristic for choosing the entity
 * name (matches the legacy `learner.ts` rule). When neither side is
 * Pinnacle, we use the longer team name as canonical.
 */
export async function harvestMatchPair(
  eventA: NormalizedEvent,
  eventB: NormalizedEvent,
  preNormA: PreNormalizedNames,
  preNormB: PreNormalizedNames,
  matchScore: number,
  source: ObservationSource = "harvester",
): Promise<void> {
  try {
    const providerA =
      (Object.keys(eventA.providers)[0] as string | undefined) ?? "unknown";
    const providerB =
      (Object.keys(eventB.providers)[0] as string | undefined) ?? "unknown";

    // ── Choose canonical event (Pinnacle wins; else longer name) ──
    const canonical = eventA.providers.pinnacle
      ? eventA
      : eventB.providers.pinnacle
        ? eventB
        : eventA.homeTeam.length >= eventB.homeTeam.length
          ? eventA
          : eventB;
    const variant = canonical === eventA ? eventB : eventA;
    const variantProvider = canonical === eventA ? providerB : providerA;
    const variantPreNorm = canonical === eventA ? preNormB : preNormA;

    // ── Resolve / create the canonical competition entity ──
    const compEntity = await ensureCompetitionEntity(canonical.competition);
    const competitionId = compEntity?.id ?? null;

    // ── Resolve / create the canonical team entities ──
    const homeEntity = await ensureTeamEntity({
      canonicalName: canonical.homeTeam,
      competitionId,
    });
    const awayEntity = await ensureTeamEntity({
      canonicalName: canonical.awayTeam,
      competitionId,
    });

    // ── Are home/away swapped between the two providers? ──
    const sideA = preNormA;
    const sideB = preNormB;
    const normalScore =
      diceLite(sideA.home, sideB.home) + diceLite(sideA.away, sideB.away);
    const swappedScore =
      diceLite(sideA.home, sideB.away) + diceLite(sideA.away, sideB.home);
    const isSwapped = swappedScore > normalScore;

    const variantHome = isSwapped ? variantPreNorm.away : variantPreNorm.home;
    const variantAway = isSwapped ? variantPreNorm.home : variantPreNorm.away;
    const variantHomeRaw = isSwapped ? variant.awayTeam : variant.homeTeam;
    const variantAwayRaw = isSwapped ? variant.homeTeam : variant.awayTeam;

    // ── Record observations: variant surface → canonical entity ──
    if (homeEntity && variantHome !== sideA.home) {
      await recordObservation({
        kind: "team",
        surface: variantHomeRaw,
        provider: variantProvider,
        competitionId,
        pairedWithEntityId: homeEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
    if (awayEntity && variantAway !== sideA.away) {
      await recordObservation({
        kind: "team",
        surface: variantAwayRaw,
        provider: variantProvider,
        competitionId,
        pairedWithEntityId: awayEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }

    // Also record the canonical-side observation (so the canonical
    // surface itself accumulates evidence for the same entity_id).
    const canonicalProvider = canonical === eventA ? providerA : providerB;
    if (homeEntity) {
      await recordObservation({
        kind: "team",
        surface: canonical.homeTeam,
        provider: canonicalProvider,
        competitionId,
        pairedWithEntityId: homeEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
    if (awayEntity) {
      await recordObservation({
        kind: "team",
        surface: canonical.awayTeam,
        provider: canonicalProvider,
        competitionId,
        pairedWithEntityId: awayEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }

    // Competition observations (only if names differ — same provider
    // recording the same name as itself contributes no information).
    if (variant.competition !== canonical.competition && compEntity) {
      await recordObservation({
        kind: "competition",
        surface: variant.competition,
        provider: variantProvider,
        competitionId: null,
        pairedWithEntityId: compEntity.id,
        matchScore,
        outcome: "matched",
        source,
      });
    }
  } catch (err) {
    logger.warn(tag, `harvestMatchPair failed: ${(err as Error).message}`);
  }
}

/** Tiny Dice-coefficient on character bigrams. Used only for the
 *  home/away swap heuristic above; the matcher's main scoring path uses
 *  the full string-similarity package. */
function diceLite(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}

// Re-export the comp resolver so the matcher can populate the
// competition cache before the comp observations fire.
export { resolveCompetitionSurface };
