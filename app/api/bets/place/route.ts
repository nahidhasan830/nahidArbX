/**
 * POST /api/bets/place
 *
 * Unified manual-placement entry point. Handles two inputs:
 *
 *   Shape A — by value_bet id (historical/persisted opportunity):
 *     { valueBetId: string, kellyStake: number, providerRefs?: {...} }
 *
 *   Shape B — runtime descriptor (detected in-memory, not yet persisted):
 *     { runtime: { eventId, familyId, atomId, atomLabel, homeTeam,
 *                  awayTeam, competition?, eventStartTime, marketType,
 *                  softProvider, softOdds, sharpProvider, sharpOdds,
 *                  sharpTrueProb, commissionPct },
 *       kellyStake: number,
 *       providerRefs?: {...}
 *     }
 *
 * Both shapes converge on `placeBetForValueBet`.
 */
import { NextResponse } from "next/server";
import { getBetById, type ValueBetRow } from "@/lib/db/repositories/bets";
import { placeBetForValueBet } from "@/lib/betting/placer";
import { logger } from "@/lib/shared/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface RuntimeDescriptor {
  eventId: string;
  familyId: string;
  atomId: string;
  atomLabel: string;
  homeTeam: string;
  awayTeam: string;
  competition?: string | null;
  eventStartTime: string;
  marketType: string;
  softProvider: string;
  softOdds: number;
  /**
   * Sharp baseline is optional. When the operator places a bet on a row
   * that has no sharp/trueProb data (pure manual placement, no edge
   * detected) we synthesize a zero-EV baseline from the soft odds so
   * the persistence layer's NOT NULL constraints are satisfied and the
   * row is still traceable. Bets placed this way are tagged via
   * `softCommissionPct` bookkeeping as coming from a synthesized
   * baseline — they won't pollute real EV-driven metrics.
   */
  sharpProvider?: string;
  sharpOdds?: number;
  sharpTrueProb?: number;
  commissionPct: number;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    logger.warn("BetPlaceAPI", "invalid JSON body");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { valueBetId, runtime, kellyStake, providerRefs } = (body ?? {}) as {
    valueBetId?: string;
    runtime?: RuntimeDescriptor;
    kellyStake?: number;
    providerRefs?: Record<string, string | number>;
  };

  // Log every placement attempt up-front with identifying fields but not
  // the full payload — ops needs to correlate outcomes with requests.
  const logCtx = {
    mode: valueBetId ? "by-id" : runtime ? "runtime" : "invalid",
    valueBetId: valueBetId ?? null,
    softProvider: runtime?.softProvider ?? null,
    eventId: runtime?.eventId ?? null,
    familyId: runtime?.familyId ?? null,
    atomId: runtime?.atomId ?? null,
    softOdds: runtime?.softOdds ?? null,
    kellyStake: kellyStake ?? null,
    hasProviderRefs: Boolean(providerRefs),
  };
  logger.info("BetPlaceAPI", "placement attempt received", logCtx);

  if (
    typeof kellyStake !== "number" ||
    !Number.isFinite(kellyStake) ||
    kellyStake <= 0
  ) {
    logger.warn("BetPlaceAPI", "validation failed: invalid kellyStake", {
      kellyStake,
    });
    return NextResponse.json(
      { error: "kellyStake must be a positive number" },
      { status: 400 },
    );
  }

  let valueBet: ValueBetRow | null = null;
  if (valueBetId && typeof valueBetId === "string") {
    valueBet = await getBetById(valueBetId);
    if (!valueBet) {
      logger.warn("BetPlaceAPI", "value_bet not found", { valueBetId });
      return NextResponse.json(
        { error: `value_bet ${valueBetId} not found` },
        { status: 404 },
      );
    }
  } else if (runtime) {
    const err = validateRuntime(runtime);
    if (err) {
      logger.warn("BetPlaceAPI", "validation failed: runtime descriptor", {
        error: err,
        runtime: safeRuntime(runtime),
      });
      return NextResponse.json({ error: err }, { status: 400 });
    }
    valueBet = synthesizeRow(runtime);
  } else {
    logger.warn("BetPlaceAPI", "validation failed: no valueBetId or runtime");
    return NextResponse.json(
      { error: "Provide either valueBetId or runtime descriptor" },
      { status: 400 },
    );
  }

  const outcome = await placeBetForValueBet({
    valueBet: valueBet as unknown as ValueBetRow,
    kellyStake,
    providerRefs,
    mode: "manual",
  });

  const httpStatus =
    outcome.status === "placed"
      ? 200
      : outcome.status === "pending"
        ? 202 // book accepted, ticket arrives async
        : outcome.status === "skipped"
          ? 200
          : outcome.status === "rejected"
            ? 409
            : 500;

  const durationMs = Date.now() - startedAt;
  const outcomeLog = {
    ...logCtx,
    outcome: outcome.status,
    httpStatus,
    durationMs,
    reason: (outcome as { reason?: string }).reason ?? null,
    ticketId: (outcome as { ticketId?: string }).ticketId ?? null,
    bookedOdds: (outcome as { bookedOdds?: number }).bookedOdds ?? null,
    stake: (outcome as { stake?: number }).stake ?? null,
  };
  if (outcome.status === "placed" || outcome.status === "pending") {
    logger.info("BetPlaceAPI", `placement ${outcome.status}`, outcomeLog);
  } else if (outcome.status === "rejected" || outcome.status === "error") {
    logger.error("BetPlaceAPI", `placement ${outcome.status}`, outcomeLog);
  } else {
    logger.warn("BetPlaceAPI", `placement skipped`, outcomeLog);
  }

  return NextResponse.json(outcome, { status: httpStatus });
}

/** Strip sharp fields for log output — they're noisy and reproducible from the ids. */
function safeRuntime(r: RuntimeDescriptor): Partial<RuntimeDescriptor> {
  return {
    eventId: r.eventId,
    familyId: r.familyId,
    atomId: r.atomId,
    softProvider: r.softProvider,
    softOdds: r.softOdds,
    marketType: r.marketType,
  };
}

function validateRuntime(r: RuntimeDescriptor): string | null {
  const required: (keyof RuntimeDescriptor)[] = [
    "eventId",
    "familyId",
    "atomId",
    "atomLabel",
    "homeTeam",
    "awayTeam",
    "eventStartTime",
    "marketType",
    "softProvider",
  ];
  for (const k of required) {
    if (r[k] == null || r[k] === "") return `runtime.${String(k)} is required`;
  }
  if (!Number.isFinite(r.softOdds) || r.softOdds <= 1)
    return "runtime.softOdds must be > 1";

  // Sharp baseline is optional — but if ANY sharp field is supplied,
  // ALL must be supplied and internally consistent. Half-populated
  // sharp data is an ambiguous caller bug, not a manual-placement case.
  const anySharp =
    r.sharpProvider != null || r.sharpOdds != null || r.sharpTrueProb != null;
  const allSharp =
    r.sharpProvider != null &&
    r.sharpProvider !== "" &&
    r.sharpOdds != null &&
    r.sharpTrueProb != null;
  if (anySharp && !allSharp) {
    return "runtime sharp fields must be supplied together (sharpProvider, sharpOdds, sharpTrueProb) or omitted together";
  }
  if (allSharp) {
    if (!Number.isFinite(r.sharpOdds!) || r.sharpOdds! <= 1)
      return "runtime.sharpOdds must be > 1";
    if (
      !Number.isFinite(r.sharpTrueProb!) ||
      r.sharpTrueProb! <= 0 ||
      r.sharpTrueProb! >= 1
    )
      return "runtime.sharpTrueProb must be in (0, 1)";
  }
  return null;
}

/**
 * Build a transient ValueBetRow shape from runtime data. This row is
 * NEVER written to the DB — it exists only to satisfy the placer's
 * input contract. When the detector later persists the same opportunity
 * it'll produce its own row with this same stable id.
 */
function synthesizeRow(r: RuntimeDescriptor): ValueBetRow {
  const nowIso = new Date().toISOString();
  const stableId = `${r.eventId}|${r.familyId}|${r.atomId}`;

  // Synthesize a zero-EV sharp baseline when the caller didn't provide
  // one (pure manual placement on a row with no sharp data). Using the
  // soft odds as the sharp proxy and 1/softOdds as trueProb gives EV=0,
  // which is the correct semantic: "we have no edge signal here, the
  // operator placed on vibes". Persistence NOT NULL constraints are
  // satisfied without polluting aggregate EV stats.
  const hasSharp =
    r.sharpProvider != null && r.sharpOdds != null && r.sharpTrueProb != null;
  const sharpProvider = hasSharp ? r.sharpProvider! : r.softProvider;
  const sharpOdds = hasSharp ? r.sharpOdds! : r.softOdds;
  const sharpTrueProb = hasSharp ? r.sharpTrueProb! : 1 / r.softOdds;

  return {
    id: stableId,
    eventId: r.eventId,
    familyId: r.familyId,
    atomId: r.atomId,
    atomLabel: r.atomLabel,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    competition: r.competition ?? null,
    eventStartTime: r.eventStartTime,
    marketType: r.marketType,
    timeScope: "FT",
    familyLine: null,
    sharpProvider,
    sharpOdds,
    sharpTrueProb,
    softProvider: r.softProvider,
    softCommissionPct: r.commissionPct,
    softOdds: r.softOdds,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    tickCount: 1,
    closingSharpOdds: null,
    outcome: "pending",
    settledBySource: null,
    settledAt: null,
    settleAttempts: 0,
    lastSettleAttemptAt: null,
  } as ValueBetRow;
}
