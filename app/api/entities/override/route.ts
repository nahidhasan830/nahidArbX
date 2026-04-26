/**
 * Operator override — flips the status of an auto-decided surface form
 * (Layer 1 reversibility).
 *
 * Called when the operator clicks "Override -> Different" or
 * "Override -> Same" in the Recent auto-decisions feed.
 *
 * 5-step transactional reversal:
 *   1. Flip `entity_names.status`
 *   2. Log `manual-reject` / `manual-confirm` observation
 *   3. Write `entity_decision_blocklist` entry (30 days)
 *   4. Notify resolver cache invalidation
 *   5. Split-back (future — omitted here for simplicity; usually
 *      merges escalate anyway per Layer 2).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getEntityNameById,
  setEntityNameStatus,
} from "@/lib/db/repositories/entities";
import { recordObservation } from "@/lib/matching/entities/observations";
import { addBlocklistEntry } from "@/lib/matching/entities/blocklist";
import { notifyResolverInvalidation } from "@/lib/matching/entities/resolver";

const PostBody = z.object({
  entityNameId: z.string().min(1),
  newStatus: z.enum(["active", "retired"]),
});

export async function POST(request: NextRequest) {
  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  const en = await getEntityNameById(body.entityNameId);
  if (!en) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (en.status === body.newStatus) {
    return NextResponse.json({ success: true, message: "No change" });
  }

  // 1. Flip status
  await setEntityNameStatus(en.id, body.newStatus);

  // 2. Log manual observation (the strongest training signal)
  await recordObservation({
    kind: "team", // Assume team here; could pass from UI if needed
    surface: en.surfaceRaw,
    provider: en.provider,
    competitionId: en.competitionId,
    pairedWithEntityId: en.entityId,
    matchScore: 1, // manual
    outcome: body.newStatus === "active" ? "manual-confirm" : "manual-reject",
    source: "match-review",
    metadata: {
      auto: false,
      reason: "operator override",
      overridden_status: en.status,
    },
  });

  // 3. Blocklist
  await addBlocklistEntry({
    provider: en.provider,
    surfaceNormalized: en.surfaceNormalized,
    competitionId: en.competitionId,
    blockedEntityId: en.entityId,
    reason:
      body.newStatus === "retired" ? "manual-reject" : "manual-confirm-undone",
  });

  // 4. Invalidate cross-worker LRU cache
  await notifyResolverInvalidation();

  return NextResponse.json({
    success: true,
    message: `Overrode to ${body.newStatus}`,
  });
}
