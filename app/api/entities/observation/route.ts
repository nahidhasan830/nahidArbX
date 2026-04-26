/**
 * Test-bench endpoint for the EntityInspector playground.
 *
 * Lets an operator submit a single observation against the live store
 * exactly like the matcher / settle / match-review writers would. Use
 * with care — this writes real data to name_observations and updates
 * the candidate counter on entity_names.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "@/lib/matching/entities";

const Body = z.object({
  kind: z.enum(["team", "competition"]),
  surface: z.string().min(1),
  canonicalName: z.string().min(1),
  provider: z.string().min(1),
  competition: z.string().optional(),
  outcome: z
    .enum([
      "matched",
      "rejected",
      "near-match",
      "manual-confirm",
      "manual-reject",
    ])
    .default("manual-confirm"),
});

export async function POST(request: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: `Bad request: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const compEntity = body.competition
    ? await ensureCompetitionEntity(body.competition)
    : null;
  const competitionId = compEntity?.id ?? null;

  let entityId: string | null = null;
  if (body.kind === "team") {
    const ent = await ensureTeamEntity({
      canonicalName: body.canonicalName,
      competitionId,
    });
    entityId = ent?.id ?? null;
  } else {
    const ent = await ensureCompetitionEntity(body.canonicalName);
    entityId = ent?.id ?? null;
  }

  if (!entityId) {
    return NextResponse.json(
      { error: "Failed to create canonical entity" },
      { status: 500 },
    );
  }

  await recordObservation({
    kind: body.kind,
    surface: body.surface,
    provider: body.provider,
    competitionId,
    pairedWithEntityId: entityId,
    matchScore: 1,
    outcome: body.outcome,
    source: "match-review",
    metadata: { from: "playground" },
  });

  return NextResponse.json({
    success: true,
    entityId,
    competitionId,
    message: `Observation recorded for ${body.kind} "${body.surface}" → "${body.canonicalName}"`,
  });
}
