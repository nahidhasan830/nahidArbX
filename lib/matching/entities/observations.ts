
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

const SOURCE_WEIGHT_MULTIPLIER: Record<ObservationSource, number> = {
  "match-review": 4, // operator confirm = high trust
  learner: 2,
  settle: 4, // settlement-derived = high trust (score data is ground truth)
  harvester: 1,
};

function providerWeight(provider: string): number {
  return getProviderObservationWeight(provider);
}


export interface RecordObservationInput {
  kind: EntityKind;
  surface: string;
  provider: string;
  competitionId: string | null;
  pairedWithEntityId: string | null;
  matchScore: number | null;
  classifierScore?: number | null;
  outcome: ObservationOutcome;
  source: ObservationSource;
  metadata?: Record<string, unknown>;
}

export async function recordObservation(
  input: RecordObservationInput,
): Promise<void> {
  try {
    const surfaceNormalized =
      input.kind === "competition"
        ? normalizeCompetition(input.surface)
        : normalize(input.surface);

    if (!surfaceNormalized || surfaceNormalized.length < 2) return;

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

    if (!input.pairedWithEntityId) return;

    const candidate = await upsertEntityName({
      entityId: input.pairedWithEntityId,
      competitionId: input.competitionId,
      provider: input.provider,
      surfaceRaw: input.surface,
      surfaceNormalized,
      status: "candidate",
    });

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
      await updateNameAfterObservation(candidate.id, {
        classifierScore: input.classifierScore ?? undefined,
      });
    }

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


export async function ensureCompetitionEntity(
  rawCompetition: string,
): Promise<EntityRow | null> {
  const trimmed = rawCompetition.trim();
  if (!trimmed) return null;

  const canonical = trimmed;
  const id = buildEntityId({ kind: "competition", canonicalName: canonical });
  const existing = await getEntityById(id);
  if (existing) return existing;
  return upsertEntity({ kind: "competition", canonicalName: canonical });
}

export async function ensureTeamEntity(opts: {
  canonicalName: string;
  competitionId?: string | null;
}): Promise<EntityRow | null> {
  const trimmed = opts.canonicalName.trim();
  if (!trimmed) return null;
  const gender = /\bwomen\b|\(w\)|\(wom/i.test(trimmed) ? "f" : "m";
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

async function runAutoResolveBackground(candidateId: string): Promise<void> {
  try {
    const refreshed = await getEntityNameById(candidateId);
    if (!refreshed) return;
    if (refreshed.status !== "candidate") return;
    await autoResolve({ candidate: refreshed });
  } catch (err) {
    logger.warn(
      tag,
      `runAutoResolveBackground failed: ${(err as Error).message}`,
    );
  }
}
