import { randomUUID } from "node:crypto";
import { getBettingProvider } from "./registry";
import { isAutoPlaceEnabled } from "./auto-place-config";
import {
  DuplicatePlacedBetError,
  insertPlacedBet,
  releaseReservation,
  reservePlacement,
} from "@/lib/db/repositories/bets";
import { notify } from "@/lib/notifier";
import { logger } from "@/lib/shared/logger";
import { getMarketLimits as getCachedMarketLimits } from "@/lib/atoms/market-limits-store";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { computeStake, deriveEdge } from "./sizing";
import { MIN_EV_PCT } from "@/lib/shared/constants";
import { recordDecision } from "@/lib/db/repositories/auto-placer-log";
import { computeModelEdgePctAtOdds } from "@/lib/ml/staker";
import {
  newPlacementId,
  registerPendingConfirmation as nwRegisterPendingConfirmation,
} from "@/lib/betting/ninewickets/placement-confirmation";
import {
  newPlacementId as velkiNewPlacementId,
  registerPendingConfirmation as velkiRegisterPendingConfirmation,
} from "@/lib/betting/velki/placement-confirmation";
import type { ProviderKey } from "@/lib/atoms/types";
import type { ValueBetRow } from "@/lib/bets-history/types";
import { providerRequiresPlacementConfirmation } from "@/lib/providers/registry";

export type PlacementOutcome =
  | {
      status: "placed";
      placedBetId: string;
      bookedOdds: number;
      stake: number;
      ticketId?: string;
    }
  | {
      status: "pending";
      placedBetId: string;
      bookedOdds: number;
      stake: number;
      ticketId?: string;
    }
  | {
      status: "skipped";
      reason: string;
      _logStake?: number;
      _logBalance?: number;
    }
  | {
      status: "rejected";
      reason: string;
      _logStake?: number;
      _logBalance?: number;
    }
  | {
      status: "error";
      reason: string;
      _logStake?: number;
      _logBalance?: number;
    };

export interface PlaceForValueBetArgs {
  valueBet: ValueBetRow;
  kellyStake: number;
  mlKellyMultiplier?: number | null;
  mlScore?: number | null;
  mlModelVersion?: number | null;
  mlFeatures?: number[] | null;
  mlFeatureVersion?: number | null;
  mlFeatureCount?: number | null;
  mlFeatureNamesHash?: string | null;
  providerRefs?: Record<string, string | number>;
  mode: "auto" | "manual";
}

type PlacementMlDecision = "skip" | "shrink" | "agree" | "boost";

interface PlacementMlSnapshot {
  placedMlScore: number | null;
  placedMlModelEdgePct: number | null;
  placedMlDecision: PlacementMlDecision | null;
  placedMlKellyMultiplier: number | null;
  placedMlModelVersion: number | null;
  placedMlFeatures: number[] | null;
  placedMlFeatureVersion: number | null;
  placedMlFeatureCount: number | null;
  placedMlFeatureNamesHash: string | null;
}

const inflightPlacements = new Map<string, Promise<PlacementOutcome>>();

export function placeBetForValueBet(
  args: PlaceForValueBetArgs,
): Promise<PlacementOutcome> {
  const key = `${args.valueBet.eventId}|${args.valueBet.familyId}|${args.valueBet.atomId}`;
  const existing = inflightPlacements.get(key);
  if (existing) {
    const result: PlacementOutcome = {
      status: "skipped",
      reason: "Placement already in flight for this selection",
    };
    if (args.mode === "auto") {
      logAutoPlacerOutcome(args, result, "inflight");
    }
    return Promise.resolve(result);
  }
  const promise = placeBetForValueBetImpl(args)
    .then((outcome) => {
      if (args.mode === "auto") {
        logAutoPlacerOutcome(args, outcome);
      }
      return outcome;
    })
    .finally(() => {
      inflightPlacements.delete(key);
    });
  inflightPlacements.set(key, promise);
  return promise;
}

function logAutoPlacerOutcome(
  args: PlaceForValueBetArgs,
  outcome: PlacementOutcome,
  gateOverride?: string,
): void {
  const vb = args.valueBet;
  const betId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
  const gate = gateOverride ?? inferGate(outcome);

  const evPct = computeEvPctSafe(vb, Number(vb.softOdds));

  const logStake =
    "stake" in outcome
      ? outcome.stake
      : "_logStake" in outcome
        ? (outcome._logStake ?? null)
        : null;
  const logBalance =
    "_logBalance" in outcome ? (outcome._logBalance ?? null) : null;

  recordDecision({
    betId,
    gate,
    status: outcome.status,
    reason: "reason" in outcome ? outcome.reason : null,
    softProvider: vb.softProvider,
    homeTeam: vb.homeTeam ?? null,
    awayTeam: vb.awayTeam ?? null,
    competition: vb.competition ?? null,
    eventStartTime: vb.eventStartTime ?? null,
    marketType: vb.marketType ?? null,
    atomLabel: vb.atomLabel ?? null,
    softOdds: Number(vb.softOdds) || null,
    sharpOdds: Number(vb.sharpOdds) || null,
    evPct,
    mlScore: args.mlScore ?? null,
    mlModelEdgePct: buildPlacementMlSnapshot(
      args,
      "bookedOdds" in outcome && outcome.bookedOdds != null
        ? outcome.bookedOdds
        : Number(vb.softOdds),
      Number(vb.softCommissionPct ?? 0),
    ).placedMlModelEdgePct,
    mlDecision: classifyPlacementMlDecision(args.mlKellyMultiplier),
    mlKellyMultiplier: args.mlKellyMultiplier ?? null,
    stake: logStake,
    balance: logBalance,
    bookedOdds: "bookedOdds" in outcome ? outcome.bookedOdds : null,
    ticketId: "ticketId" in outcome ? (outcome.ticketId ?? null) : null,
  });
}

function inferGate(outcome: PlacementOutcome): string {
  if (outcome.status === "placed") return "placed";
  if (outcome.status === "pending") return "pending";
  if (outcome.status === "rejected") return "book_reject";
  if (outcome.status === "error") return "book_error";
  const r = ("reason" in outcome ? outcome.reason : "") ?? "";
  const rl = r.toLowerCase();
  if (rl.includes("auto-place disabled")) return "toggle";
  if (rl.includes("no adapter")) return "adapter";
  if (rl.includes("resolve") || rl.includes("market may have closed"))
    return "refs";
  if (rl.includes("account") || rl.includes("suspended")) return "account";
  if (rl.includes("ev decayed") || rl.includes("ev ")) return "ev_floor";
  if (rl.includes("balance") || rl.includes("exceeds balance"))
    return "balance";
  if (rl.includes("market max") || rl.includes("below auto-place bucket"))
    return "market_max";
  if (rl.includes("already reserved") || rl.includes("duplicate"))
    return "dedup";
  if (rl.includes("in flight")) return "inflight";
  if (rl.includes("kelly stake") || rl.includes("below book minimum"))
    return "stake_min";
  return "unknown";
}

function classifyPlacementMlDecision(
  multiplier: number | null | undefined,
): PlacementMlDecision | null {
  if (multiplier == null || !Number.isFinite(multiplier)) return null;
  if (multiplier < 0.1) return "skip";
  if (multiplier < 0.95) return "shrink";
  if (multiplier > 1.05) return "boost";
  return "agree";
}

function buildPlacementMlSnapshot(
  args: Pick<
    PlaceForValueBetArgs,
    | "mlScore"
    | "mlKellyMultiplier"
    | "mlModelVersion"
    | "mlFeatures"
    | "mlFeatureVersion"
    | "mlFeatureCount"
    | "mlFeatureNamesHash"
  >,
  bookedOdds: number,
  commissionPct: number,
): PlacementMlSnapshot {
  const mlScore =
    args.mlScore != null && Number.isFinite(args.mlScore)
      ? Number(args.mlScore)
      : null;
  const modelEdgePct =
    mlScore == null
      ? null
      : computeModelEdgePctAtOdds(mlScore, bookedOdds, commissionPct);

  return {
    placedMlScore: mlScore,
    placedMlModelEdgePct: modelEdgePct,
    placedMlDecision: classifyPlacementMlDecision(args.mlKellyMultiplier),
    placedMlKellyMultiplier:
      args.mlKellyMultiplier != null && Number.isFinite(args.mlKellyMultiplier)
        ? Number(args.mlKellyMultiplier)
        : null,
    placedMlModelVersion: args.mlModelVersion ?? null,
    placedMlFeatures: args.mlFeatures ?? null,
    placedMlFeatureVersion: args.mlFeatureVersion ?? null,
    placedMlFeatureCount: args.mlFeatureCount ?? null,
    placedMlFeatureNamesHash: args.mlFeatureNamesHash ?? null,
  };
}

async function placeBetForValueBetImpl(
  args: PlaceForValueBetArgs,
): Promise<PlacementOutcome> {
  const { valueBet, mode } = args;
  const providerId = valueBet.softProvider;
  const adapter = getBettingProvider(providerId);

  const baseBet = {
    id: randomUUID(),
    valueBetId: valueBet.id,
    eventId: valueBet.eventId,
    familyId: valueBet.familyId,
    atomId: valueBet.atomId,
    atomLabel: valueBet.atomLabel,
    eventName: `${valueBet.homeTeam} vs ${valueBet.awayTeam}`,
    competition: valueBet.competition,
    eventStartTime: valueBet.eventStartTime,
    marketType: valueBet.marketType,
    provider: providerId,
    currency: adapter?.currency ?? "BDT",
    mode,
  } as const;

  if (!adapter) {
    return {
      status: "skipped",
      reason: `No adapter registered for provider "${providerId}"`,
    };
  }


  if (mode === "auto" && !isAutoPlaceEnabled(providerId)) {
    return {
      status: "skipped",
      reason: `Auto-place disabled for ${adapter.providerDisplayName}`,
    } as PlacementOutcome;
  }

  let providerRefs = args.providerRefs;
  if (!providerRefs) {
    providerRefs = (await adapter.resolveProviderRefs({
      normalizedEventId: valueBet.eventId,
      familyId: valueBet.familyId,
      atomId: valueBet.atomId,
      homeTeam: valueBet.homeTeam,
      awayTeam: valueBet.awayTeam,
    })) as Record<string, string | number> | undefined;
  }
  if (!providerRefs) {
    return {
      status: "skipped",
      reason:
        "Couldn't resolve book-native market/selection for this atom (market may have closed or selection no longer listed)",
    } as PlacementOutcome;
  }

  let accountInfo;
  try {
    accountInfo = await adapter.getAccountInfo();
  } catch (err) {
    return {
      status: "error",
      reason: `Account info fetch failed: ${msg(err)}`,
    } as PlacementOutcome;
  }
  if (accountInfo.suspended) {
    return {
      status: "skipped",
      reason: "Account suspended by book",
      _logBalance: accountInfo.balance,
    } as PlacementOutcome;
  }

  const cached = getCachedMarketLimits(
    providerId as ProviderKey,
    valueBet.eventId,
    valueBet.atomId,
  );
  let limits: { minBetAmount: number; maxBetAmount: number } | null = cached
    ? { minBetAmount: cached.minBet, maxBetAmount: cached.maxBet }
    : null;
  if (!limits) {
    try {
      limits = await adapter.getMarketLimits(providerRefs);
    } catch (err) {
      logger.warn(
        "BetPlacer",
        `getMarketLimits failed (${msg(err)}); falling back to account minBet`,
      );
      limits = null;
    }
  }
  const minBet = limits?.minBetAmount ?? accountInfo.minBet;
  const maxBet = limits?.maxBetAmount ?? Infinity;

  const { row: settings } = await getBettingSettings();
  let targetStake: number;

  if (mode === "auto") {
    const bankroll = settings.useLiveBalance
      ? accountInfo.balance
      : settings.manualBankrollBdt;
    const { evPct, fullKelly } = deriveEdge({
      softOdds: Number(valueBet.softOdds),
      softCommissionPct: Number(valueBet.softCommissionPct),
      sharpTrueProb: Number(valueBet.sharpTrueProb),
    });
    if (evPct < MIN_EV_PCT) {
      return {
        status: "skipped",
        reason: `EV decayed to ${evPct.toFixed(2)}% (< ${MIN_EV_PCT}% floor): softOdds=${valueBet.softOdds}, sharpTrueProb=${Number(valueBet.sharpTrueProb).toFixed(4)}, comm=${valueBet.softCommissionPct}%`,
        _logBalance: accountInfo.balance,
      };
    }

    const mlMult = args.mlKellyMultiplier;
    let adjustedFullKelly = fullKelly;
    if (mlMult != null && mlMult !== 0) {
      adjustedFullKelly = fullKelly * mlMult;
      logger.info(
        "BetPlacer",
        `ML adjust: fullKelly=${fullKelly.toFixed(4)} × ${mlMult.toFixed(3)} = ${adjustedFullKelly.toFixed(4)}`,
      );
    } else if (mlMult === 0) {
      return {
        status: "skipped",
        reason: "ML model gated this bet (multiplier=0)",
        _logBalance: accountInfo.balance,
      };
    }

    const rawStake = computeStake({
      fullKelly: adjustedFullKelly,
      bankrollBdt: bankroll,
      kellyCapPct: settings.kellyCapPct,
      kellyFraction: settings.kellyFraction,
    });
    const bucket = settings.stakeBucketBdt;
    const autoMinStake = snapUp(Math.max(minBet, settings.minStakeBdt), bucket);
    if (autoMinStake > accountInfo.balance) {
      return {
        status: "skipped",
        reason: `Auto-place floor ${autoMinStake} exceeds balance ${accountInfo.balance}`,
        _logStake: autoMinStake,
        _logBalance: accountInfo.balance,
      };
    }
    let snapped = snapDown(rawStake, bucket);
    if (snapped < autoMinStake) snapped = autoMinStake;
    logger.info(
      "BetPlacer",
      `auto: raw=${rawStake.toFixed(2)} → snapped=${snapped} ` +
        `(bucket=${bucket}, floor=${autoMinStake}, bookMin=${minBet}, ` +
        `bankroll=${bankroll}, evPct=${evPct.toFixed(2)}, kelly=${fullKelly.toFixed(4)}` +
        (mlMult != null ? `, mlMult=${mlMult.toFixed(3)}` : "") +
        `)`,
    );
    targetStake = snapped;
  } else {
    targetStake = round2(args.kellyStake);
    if (targetStake < minBet) {
      return {
        status: "skipped",
        reason: `Kelly stake ${targetStake} below book minimum ${minBet}`,
        _logStake: targetStake,
        _logBalance: accountInfo.balance,
      };
    }
  }
  if (targetStake > accountInfo.balance) {
    return {
      status: "skipped",
      reason: `Insufficient balance: need ${targetStake}, have ${accountInfo.balance}`,
      _logStake: targetStake,
      _logBalance: accountInfo.balance,
    };
  }
  let stake = Math.min(targetStake, maxBet);
  if (mode === "auto") {
    const bucket = settings.stakeBucketBdt;
    stake = snapDown(stake, bucket);
    if (stake < bucket) {
      return {
        status: "skipped",
        reason: `Market max ${maxBet} below auto-place bucket ${bucket}`,
        _logStake: stake,
        _logBalance: accountInfo.balance,
      };
    }
  }
  const odds = Number(valueBet.softOdds);

  const reservation = await reservePlacement({
    eventId: valueBet.eventId,
    familyId: valueBet.familyId,
    atomId: valueBet.atomId,
    provider: providerId,
    mode,
    currency: adapter.currency,
    shell: {
      atomLabel: valueBet.atomLabel,
      homeTeam: valueBet.homeTeam,
      awayTeam: valueBet.awayTeam,
      competition: valueBet.competition,
      eventStartTime: valueBet.eventStartTime,
      marketType: valueBet.marketType,
      timeScope: valueBet.timeScope as string,
      familyLine: valueBet.familyLine ?? null,
      sharpProvider: valueBet.sharpProvider,
      sharpOdds: Number(valueBet.sharpOdds),
      sharpTrueProb: Number(valueBet.sharpTrueProb),
      softProvider: valueBet.softProvider,
      softCommissionPct: Number(valueBet.softCommissionPct),
      softOdds: Number(valueBet.softOdds),
    },
  });
  if (!reservation.reserved) {
    return {
      status: "skipped",
      reason:
        "Already reserved/placed — another tick beat us to this (event, market, selection)",
      _logStake: stake,
      _logBalance: accountInfo.balance,
    };
  }
  const reservedBetId = reservation.id;

  logger.info("BetPlacer", "submitting to book", {
    provider: providerId,
    eventId: valueBet.eventId,
    familyId: valueBet.familyId,
    atomId: valueBet.atomId,
    stake,
    odds,
    minBet,
    maxBet: Number.isFinite(maxBet) ? maxBet : null,
    balance: accountInfo.balance,
    mode,
    providerRefs,
  });
  let attempt;
  try {
    attempt = await adapter.placeBet({
      providerRefs,
      stake,
      odds,
      currency: adapter.currency,
    });
  } catch (err) {
    await releaseReservation(reservedBetId).catch((relErr) => {
      logger.error(
        "BetPlacer",
        `releaseReservation failed after adapter throw: ${msg(relErr)}`,
      );
    });
    throw err;
  }
  if (attempt.status === "placed" || attempt.status === "pending") {
    logger.info("BetPlacer", `book ${attempt.status}`, {
      provider: providerId,
      ticketId: attempt.ticketId ?? null,
      bookedOdds: attempt.bookedOdds ?? null,
      stake,
      requestedOdds: odds,
    });
    if (
      typeof attempt.bookedOdds === "number" &&
      Math.abs(attempt.bookedOdds - odds) > 0.02
    ) {
      logger.warn("BetPlacer", "odds drift in placement response", {
        provider: providerId,
        eventId: valueBet.eventId,
        atomId: valueBet.atomId,
        requestedOdds: odds,
        bookedOdds: attempt.bookedOdds,
        delta: Number((attempt.bookedOdds - odds).toFixed(4)),
      });
    }
  } else {
    logger.error("BetPlacer", `book ${attempt.status}`, {
      provider: providerId,
      eventId: valueBet.eventId,
      familyId: valueBet.familyId,
      atomId: valueBet.atomId,
      stake,
      requestedOdds: odds,
      translatedError: attempt.error ?? null,
      rawResponse: attempt.response ?? null,
      rawRequest: attempt.request ?? null,
    });
  }

  const baseInsert = {
    ...baseBet,
    stake,
    odds,
    providerTicketId: attempt.ticketId ?? null,
  };

  if (attempt.status === "placed" || attempt.status === "pending") {
    const bookedOdds = attempt.bookedOdds ?? odds;
    const placementMl = buildPlacementMlSnapshot(
      args,
      bookedOdds,
      Number(valueBet.softCommissionPct ?? 0),
    );

    if (providerRequiresPlacementConfirmation(providerId)) {
      const isVelki = providerId === "velki-sportsbook";
      const placementId = isVelki ? velkiNewPlacementId() : newPlacementId();
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
      const confirmPayload = {
        placementId,
        valueBetId: valueBet.id,
        eventId: valueBet.eventId,
        familyId: valueBet.familyId,
        atomId: valueBet.atomId,
        atomLabel: valueBet.atomLabel,
        eventName: baseBet.eventName,
        competition: valueBet.competition,
        sport: inferSport(valueBet.competition),
        eventStartTime: valueBet.eventStartTime,
        marketType: valueBet.marketType,
        provider: providerId,
        providerDisplayName: adapter.providerDisplayName,
        currency: adapter.currency,
        mode,
        stake,
        bookedOdds,
        evPct: computeEvPctSafe(valueBet, bookedOdds),
        softCommissionPct: Number(valueBet.softCommissionPct ?? 0),
        marketId: extractRefString(providerRefs, "marketId"),
        selectionId: extractRefNumber(providerRefs, "selectionId"),
        betfairEventId: extractRefNumber(providerRefs, "betfairEventId"),
        timeScope: valueBet.timeScope,
        familyLine:
          valueBet.familyLine !== null && valueBet.familyLine !== undefined
            ? String(valueBet.familyLine)
            : null,
        dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
        ticketIdHint: attempt.ticketId ?? null,
        balanceAtSubmit: accountInfo.balance,
        ...placementMl,
      } as const;
      if (isVelki) {
        velkiRegisterPendingConfirmation(confirmPayload);
      } else {
        nwRegisterPendingConfirmation(confirmPayload);
      }
      return {
        status: "pending",
        placedBetId: placementId,
        bookedOdds,
        stake,
        ticketId: attempt.ticketId,
      };
    }

    const isPending = attempt.status === "pending";
    let row;
    try {
      row = await insertPlacedBet({
        id: baseInsert.id,
        eventId: baseInsert.eventId,
        familyId: baseInsert.familyId,
        atomId: baseInsert.atomId,
        atomLabel: baseInsert.atomLabel,
        homeTeam: valueBet.homeTeam,
        awayTeam: valueBet.awayTeam,
        competition: baseInsert.competition,
        eventStartTime: baseInsert.eventStartTime,
        marketType: baseInsert.marketType,
        timeScope: valueBet.timeScope as string,
        familyLine: valueBet.familyLine ?? null,
        sharpProvider: valueBet.sharpProvider,
        sharpOdds: Number(valueBet.sharpOdds),
        sharpTrueProb: Number(valueBet.sharpTrueProb),
        softProvider: valueBet.softProvider,
        softCommissionPct: Number(valueBet.softCommissionPct),
        softOdds: Number(valueBet.softOdds),

        provider: baseInsert.provider,
        stake,
        odds: bookedOdds,
        currency: baseInsert.currency,
        providerTicketId: attempt.ticketId ?? null,
        mode,
        ...placementMl,
      });
    } catch (err) {
      if (err instanceof DuplicatePlacedBetError) {
        logger.warn(
          "BetPlacer",
          `duplicate placement for ${err.eventId}|${err.familyId}|${err.atomId} — ` +
            `book accepted but row already exists (book ticket ${attempt.ticketId ?? "n/a"}). ` +
            `In-process lock was bypassed; see DB unique index for backstop.`,
        );
        return {
          status: "skipped",
          reason:
            "Duplicate placement — an earlier racing insert already recorded this bet",
        };
      }
      throw err;
    }

    if (isPending) {
      logger.info(
        "BetPlacer",
        `bet accepted by ${adapter.providerDisplayName} but still processing ` +
          `(ticket ${attempt.ticketId ?? "n/a"}) — will reconcile via myBets`,
      );
    }

    if (!isPending) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
      await notify({
        type: "bet:placed",
        at: row.placedAt ?? new Date().toISOString(),
        provider: providerId,
        providerDisplayName: adapter.providerDisplayName,
        eventName: baseBet.eventName,
        competition: valueBet.competition,
        sport: inferSport(valueBet.competition),
        eventStartTime: valueBet.eventStartTime,
        marketName: valueBet.marketType,
        selectionName: valueBet.atomLabel,
        stake: Number(row.stake),
        odds: Number(row.odds),
        currency: adapter.currency,
        mode,
        evPct: computeEvPctSafe(valueBet, Number(row.odds)),
        timeScope: valueBet.timeScope,
        familyLine:
          valueBet.familyLine !== null && valueBet.familyLine !== undefined
            ? String(valueBet.familyLine)
            : null,
        ticketId: row.providerTicketId ?? undefined,
        balance: accountInfo.balance - Number(row.stake),
        dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
      });
    }
    return {
      status: isPending ? "pending" : "placed",
      placedBetId: row.id,
      bookedOdds: Number(row.odds),
      stake: Number(row.stake),
      ticketId: row.providerTicketId ?? undefined,
    };
  }

  const errorMsg = attempt.error ?? "Unknown placement failure";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  await notify({
    type: "bet:error",
    at: new Date().toISOString(),
    provider: providerId,
    providerDisplayName: adapter.providerDisplayName,
    eventName: baseBet.eventName,
    competition: valueBet.competition,
    sport: inferSport(valueBet.competition),
    eventStartTime: valueBet.eventStartTime,
    marketName: valueBet.marketType,
    selectionName: valueBet.atomLabel,
    timeScope: valueBet.timeScope,
    familyLine:
      valueBet.familyLine !== null && valueBet.familyLine !== undefined
        ? String(valueBet.familyLine)
        : null,
    error: errorMsg,
    reasonCategory: classifyRejectReason(errorMsg, attempt.status),
    mode,
    stake,
    odds,
    currency: adapter.currency,
    evPct: computeEvPctSafe(valueBet, odds),
    minBet,
    maxBet: Number.isFinite(maxBet) ? maxBet : null,
    balance: accountInfo.balance,
    dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
  });

  await releaseReservation(reservedBetId).catch((relErr) => {
    logger.error(
      "BetPlacer",
      `releaseReservation failed after book ${attempt.status}: ${msg(relErr)}`,
    );
  });

  return {
    status: attempt.status === "rejected" ? "rejected" : "error",
    reason: errorMsg,
  };
}

function classifyRejectReason(
  error: string,
  status: "rejected" | "error",
): NonNullable<import("@/lib/notifier/types").BetErrorEvent["reasonCategory"]> {
  const s = error.toLowerCase();
  if (/below (the )?(market'?s )?min(imum)?|min(imum)? stake|min bet/.test(s))
    return "below_market_min";
  if (
    /above (the )?(market'?s )?max(imum)?|max(imum)? stake|max bet|limit exceeded/.test(
      s,
    )
  )
    return "above_market_max";
  if (/insufficient (balance|funds)|not enough (balance|funds)/.test(s))
    return "above_balance";
  if (/suspended|locked|disabled/.test(s)) return "suspended";
  if (/duplicate|already placed/.test(s)) return "duplicate";
  if (/timeout|timed out|econn|network|fetch/.test(s)) return "transport";
  return status === "rejected" ? "book_rejection" : "adapter_error";
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function snapDown(x: number, bucket: number): number {
  return Math.floor(x / bucket) * bucket;
}

function snapUp(x: number, bucket: number): number {
  return Math.ceil(x / bucket) * bucket;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractRefString(
  refs: Record<string, string | number>,
  key: string,
): string | null {
  const v = refs[key];
  if (v === undefined || v === null || v === "") return null;
  return String(v);
}

function extractRefNumber(
  refs: Record<string, string | number>,
  key: string,
): number | null {
  const v = refs[key];
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function computeEvPctSafe(row: ValueBetRow, bookedOdds: number): number {
  const adjusted =
    1 + (bookedOdds - 1) * (1 - Number(row.softCommissionPct) / 100);
  return round2((adjusted * Number(row.sharpTrueProb) - 1) * 100);
}

function inferSport(competition: string | null | undefined): string | null {
  if (!competition) return null;
  const c = competition.toLowerCase();
  if (
    /league|bundesliga|la liga|serie a|champions|europa|cup|premier|mls|fifa|uefa|ligue|eredivisie|world cup|efl|fa cup/.test(
      c,
    )
  )
    return "soccer";
  if (/nba|euroleague|basketball/.test(c)) return "basketball";
  if (/atp|wta|tennis|grand slam|wimbledon|roland/.test(c)) return "tennis";
  if (/ipl|t20|odi|test|cricket|bbl|psl|cpl/.test(c)) return "cricket";
  if (/nhl|hockey|khl/.test(c)) return "hockey";
  if (/mlb|baseball/.test(c)) return "baseball";
  return null;
}
