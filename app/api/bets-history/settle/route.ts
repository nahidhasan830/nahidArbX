import { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiBadRequest,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import {
  getBetsByIds,
  getPendingBetsByEventIds,
} from "@/lib/db/repositories/bets";
import { settleBatch } from "@/lib/settle/settle-batch";

const MAX_IDS = 500;

const BodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_IDS),
  bypassCache: z.boolean().default(true),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Body must be valid JSON");
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest(parsed.error.issues[0]?.message ?? "Invalid body");
  }

  try {
    const selectedRows = await getBetsByIds(parsed.data.ids);
    const eventIds = Array.from(
      new Set(selectedRows.map((row) => row.eventId)),
    );
    const pendingEventRows = await getPendingBetsByEventIds(eventIds);
    const expandedIds = Array.from(
      new Set([
        ...parsed.data.ids,
        ...pendingEventRows.map((row) => row.id),
      ]),
    );

    const result = await settleBatch(expandedIds, {
      bypassCache: parsed.data.bypassCache,
    });
    const includedRowsById = new Map(
      [...selectedRows, ...pendingEventRows].map((row) => [row.id, row]),
    );

    return apiSuccess({
      proposals: result.proposals,
      attempted: result.proposals.length,
      missing: result.missing,
      includedRows: result.proposals
        .map((proposal) => includedRowsById.get(proposal.id))
        .filter((row) => row !== undefined),
      expandedIds,
      telemetry: result.telemetry,
      unresolvedEventCount: result.telemetry.unresolvedEvents,
    });
  } catch (err) {
    return apiServerError(err, "Backtest:settle");
  }
}
