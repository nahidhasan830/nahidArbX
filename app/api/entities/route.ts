/**
 * Entity Resolution — REST surface (rebuild edition).
 *
 *   GET  /api/entities                       list/search entities
 *   GET  /api/entities?id=…                  fetch one entity + its names + observations
 *   GET  /api/entities?stats=1               aggregate stats
 *   POST /api/entities {action: "merge"}      merge entity A into B
 *   POST /api/entities {action: "retire"}     soft-retire entity
 *   POST /api/entities {action: "retire-name"} retire single entity_name row
 *   POST /api/entities {action: "promote-name"} force-promote candidate row
 *
 * Removed in the matcher rebuild:
 *   - reviewQueue read (entity_review_queue table is gone)
 *   - resolve-queue action (no review queue to resolve)
 *   - playground action (replaced by header search + override flow on
 *     the new MatcherPanel UI; raw resolver probing belongs in the
 *     EntityDrawer test-bench, not as a generic POST action)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  getEntityById,
  getEntityNamesForEntity,
  getEntityStats,
  listEntities,
  listObservationsForEntity,
  mergeEntities,
  retireEntity,
  setEntityNameStatus,
} from "@/lib/db/repositories/entities";

const PostBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("merge"),
    fromId: z.string().min(1),
    intoId: z.string().min(1),
  }),
  z.object({
    action: z.literal("retire"),
    entityId: z.string().min(1),
  }),
  z.object({
    action: z.literal("retire-name"),
    entityNameId: z.string().min(1),
  }),
  z.object({
    action: z.literal("promote-name"),
    entityNameId: z.string().min(1),
  }),
]);

export async function GET(request: NextRequest) {
  const url = new URL(request.url);

  if (url.searchParams.get("stats")) {
    return NextResponse.json({ stats: await getEntityStats() });
  }

  const id = url.searchParams.get("id");
  if (id) {
    const entity = await getEntityById(id);
    if (!entity) {
      return NextResponse.json({ error: "Entity not found" }, { status: 404 });
    }
    const names = await getEntityNamesForEntity(id);
    const obsRows = await listObservationsForEntity(id, 50);
    // bigint id — coerce at the wire boundary so JSON.stringify doesn't throw.
    const observations = obsRows.map((r) => ({ ...r, id: String(r.id) }));
    return NextResponse.json({ entity, names, observations });
  }

  const kind = url.searchParams.get("kind") as "team" | "competition" | null;
  const search = url.searchParams.get("q") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 100);
  const items = await listEntities({
    kind: kind ?? undefined,
    search,
    limit,
  });
  return NextResponse.json({ items, count: items.length });
}

export async function POST(request: NextRequest) {
  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await request.json());
  } catch (err) {
    return NextResponse.json(
      { error: `Bad request: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  switch (body.action) {
    case "merge": {
      await mergeEntities(body.fromId, body.intoId);
      return NextResponse.json({
        success: true,
        message: `Merged ${body.fromId} into ${body.intoId}`,
      });
    }
    case "retire": {
      await retireEntity(body.entityId);
      return NextResponse.json({
        success: true,
        message: `Retired ${body.entityId}`,
      });
    }
    case "retire-name": {
      await setEntityNameStatus(body.entityNameId, "retired");
      return NextResponse.json({ success: true });
    }
    case "promote-name": {
      await setEntityNameStatus(body.entityNameId, "active");
      return NextResponse.json({ success: true });
    }
  }
}
