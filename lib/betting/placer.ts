/**
 * Generic bet placer. Provider-agnostic — it leans entirely on the
 * {@link BettingProviderAdapter} interface.
 *
 * Flow:
 *   1. Dedup check (cross-provider, lifetime)
 *   2. Provider + auto-place toggle check (auto mode only)
 *   3. Balance check via adapter.getAccountInfo()
 *   4. Market limit check via adapter.getMarketLimits()
 *   5. Stake sizing: caller-supplied (Kelly), clamped to [minBetAmount,
 *      maxBetAmount]; abort if clamped stake < minBetAmount
 *   6. adapter.placeBet()
 *   7. DB write ONLY when the book confirms placement:
 *        - status='placed' → row at outcome='pending' (awaiting settlement)
 *        - status='pending' → row at outcome='pending', error='awaiting-ticket'
 *          so reconciliation via myBets can attach the ticket id later.
 *      Rejections (business rules) and errors (transport/auth) never
 *      write to the DB. If the book didn't accept it, we don't record it.
 *   8. notify(bet:placed) for placements, notify(bet:error) for
 *      rejections/errors so the UI still surfaces the failure.
 */
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
import { buildBetGradeUrl } from "@/lib/shared/google-ai-link";
import { getMarketLimits as getCachedMarketLimits } from "@/lib/atoms/market-limits-store";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { computeStake, deriveEdge } from "./sizing";
import { MIN_EV_PCT } from "@/lib/shared/constants";
import { recordDecision } from "@/lib/db/repositories/auto-placer-log";
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

/**
 * Providers whose "placed" / "pending" book responses must be verified
 * against the provider's bet-history feed before we persist to the DB.
 * Today this is 9W Sportsbook only — see
 * [placement-confirmation.ts](../ninewickets/placement-confirmation.ts)
 * for the rationale and polling protocol.
 */
const CONFIRMATION_REQUIRED_PROVIDERS = new Set<string>([
  "ninewickets-sportsbook",
  "velki-sportsbook",
]);

export type PlacementOutcome =
  | {
      status: "placed";
      placedBetId: string;
      bookedOdds: number;
      stake: number;
      ticketId?: string;
    }
  | {
      /**
       * Book accepted the bet but is still processing it; no ticket id
       * yet. We persist the row at outcome='pending' so reconciliation
       * can attach the ticket later via myBets polling.
       */
      status: "pending";
      placedBetId: string;
      bookedOdds: number;
      stake: number;
      ticketId?: string;
    }
  | {
      status: "skipped";
      reason: string;
      /** Internal: computed stake for logging (not part of public contract). */
      _logStake?: number;
      /** Internal: provider balance at decision time for logging. */
      _logBalance?: number;
    }
  | {
      /** Book rejected on a business rule. Not persisted to DB. */
      status: "rejected";
      reason: string;
      _logStake?: number;
      _logBalance?: number;
    }
  | {
      /** Transport / auth / parse failure. Not persisted to DB. */
      status: "error";
      reason: string;
      _logStake?: number;
      _logBalance?: number;
    };

export interface PlaceForValueBetArgs {
  valueBet: ValueBetRow;
  /**
   * The stake to attempt (raw Kelly in account currency). Will be
   * clamped to the market's [min, max] at placement time; if the clamp
   * would push it above Kelly we take the clamp, if it would push it
   * below Kelly we refuse to place.
   */
  kellyStake: number;
  /**
   * Optional pre-resolved provider refs (book-native marketId /
   * selectionId / etc.). When omitted the placer calls
   * `adapter.resolveProviderRefs` — that's the standard path. Tests
   * and debug tooling can pass a literal refs dict to bypass the
   * resolver.
   */
  providerRefs?: Record<string, string | number>;
  mode: "auto" | "manual";
}

/**
 * In-flight placements, keyed by `<eventId>|<familyId>|<atomId>`. Two
 * calls that arrive for the same selection while one is already running
 * share the original promise instead of each submitting their own bet
 * to the book. Without this guard a race between concurrent maybeAutoPlace
 * invocations slips through the DB-level `isAlreadyPlaced` check (which
 * is SELECT-then-INSERT, no row-lock) and the book deduplicates into a
 * single ticket id — the reconciler then attaches that one ticket to
 * every duplicate DB row and the operator sees N identical notifications.
 */
const inflightPlacements = new Map<string, Promise<PlacementOutcome>>();

export function placeBetForValueBet(
  args: PlaceForValueBetArgs,
): Promise<PlacementOutcome> {
  const key = `${args.valueBet.eventId}|${args.valueBet.familyId}|${args.valueBet.atomId}`;
  const existing = inflightPlacements.get(key);
  if (existing) {
    // Tag the outcome so the caller can tell it was a dedup merge, not
    // a fresh placement. Return a cloned skipped outcome instead of the
    // original — it's important that *this* caller not report a
    // successful placement (the notify for the real placement fires
    // once, from whichever caller owns the original promise).
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
      // Log for auto-mode placements. Manual placements don't go to the log.
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

/**
 * Map PlacementOutcome to an auto_placer_log row (fire-and-forget).
 * The gate is inferred from the outcome's reason string when not
 * explicitly provided.
 */
function logAutoPlacerOutcome(
  args: PlaceForValueBetArgs,
  outcome: PlacementOutcome,
  gateOverride?: string,
): void {
  const vb = args.valueBet;
  const betId = `${vb.eventId}|${vb.familyId}|${vb.atomId}`;
  const gate = gateOverride ?? inferGate(outcome);

  // Compute EV% from the value bet's own fields — the reactor already
  // calculated this, but the bets row stores the raw inputs, not evPct
  // directly. Use computeEvPctSafe which handles commission.
  const evPct = computeEvPctSafe(vb, Number(vb.softOdds));

  // Stake/balance from outcome metadata (set by placeBetForValueBetImpl
  // for gates that fire after sizing/balance checks).
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
    mlScore: null,
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

  // 1. Dedup now lives at step 6 (reservePlacement) — an atomic
  // INSERT ... ON CONFLICT DO UPDATE WHERE placed_at IS NULL against
  // the bets table. That replaces the previous SELECT-then-INSERT race
  // and the in-memory `hasPendingConfirmation` window that both allowed
  // cross-cycle duplicates (tickets 11057135/39/42 for Randers vs
  // Fredericia on 2026-04-24). The `inflightPlacements` map above is
  // still a cheap first-line filter for concurrent calls in-process.

  // 2. Auto-place toggle — manual bypasses this.
  if (mode === "auto" && !isAutoPlaceEnabled(providerId)) {
    return {
      status: "skipped",
      reason: `Auto-place disabled for ${adapter.providerDisplayName}`,
    } as PlacementOutcome;
  }

  // 3. Resolve book-native refs (marketId, selectionId, etc.) unless
  // caller pre-supplied them.
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

  // 4. Account state.
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

  // 4. Market limits — three-tier lookup:
  //   a) In-memory cache populated by the odds-ingest adapter on every
  //      sync. This is the authoritative per-market min/max because the
  //      odds pipeline overlays the authenticated account-tier limits;
  //      using it avoids an extra HTTP round-trip on every placement.
  //   b) Book-live fetch via adapter.getMarketLimits() — kept as a
  //      fallback in case the cache is cold (e.g. right after a restart).
  //   c) Account-global minBet from accountInfo — last-resort only.
  //      This value (~1 BDT on 9W) is far below real market minimums,
  //      which is why the auto-mode floor (step 5) has to backstop it.
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

  // 5. Stake sizing.
  //
  // Auto mode: the caller's `kellyStake` is IGNORED. Stake is computed
  // fresh from the saved strategy + live bankroll so the number is
  // always tied to the operator's latest dashboard settings and the
  // provider's current balance. The detector's stored `kellyStake` is
  // a display-time estimate only.
  //
  // Manual mode: the caller's `kellyStake` passes through unchanged
  // (fractional amounts allowed; the operator typed it in).
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
    // Hard EV floor at placement time — softOdds can decay between
    // detection and placement so we recheck against the current snapshot.
    if (evPct < MIN_EV_PCT) {
      return {
        status: "skipped",
        reason: `EV decayed to ${evPct.toFixed(2)}% (< ${MIN_EV_PCT}% floor): softOdds=${valueBet.softOdds}, sharpTrueProb=${Number(valueBet.sharpTrueProb).toFixed(4)}, comm=${valueBet.softCommissionPct}%`,
        _logBalance: accountInfo.balance,
      };
    }
    const rawStake = computeStake({
      fullKelly,
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
        `bankroll=${bankroll}, evPct=${evPct.toFixed(2)}, kelly=${fullKelly.toFixed(4)})`,
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
  // If maxBet < target we take the cap — but in auto-mode keep the
  // result on the settings-defined grid too.
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

  // 5b. Atomic DB reservation — the single source of truth for dedup.
  //
  // INSERT ... ON CONFLICT DO UPDATE WHERE placed_at IS NULL. If a
  // racing caller or an earlier cycle already reserved / placed this
  // selection, the conditional WHERE returns zero rows and we bail
  // BEFORE hitting the book. This is what prevents the duplicate
  // placements (tickets 11057135/39/42 on 2026-04-24) that slipped
  // past the in-memory `inflightPlacements` / `hasPendingConfirmation`
  // windows once the first sync cycle's confirmation cleared.
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

  // 6. Place via adapter.
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
    // Adapter threw (transport/auth failure). Roll the reservation back
    // so the next valid tick can retry this selection.
    await releaseReservation(reservedBetId).catch((relErr) => {
      logger.error(
        "BetPlacer",
        `releaseReservation failed after adapter throw: ${msg(relErr)}`,
      );
    });
    throw err;
  }
  // Structured audit log: always record the outcome, and include the
  // raw book response when the book rejected or errored so we can grow
  // the error-translation table without guessing what the book returned.
  if (attempt.status === "placed" || attempt.status === "pending") {
    logger.info("BetPlacer", `book ${attempt.status}`, {
      provider: providerId,
      ticketId: attempt.ticketId ?? null,
      bookedOdds: attempt.bookedOdds ?? null,
      stake,
      requestedOdds: odds,
    });
    // Flag response-level odds drift. This catches the book shifting
    // the price between our request and its accept ("the line moved a
    // tick, here's your bet at the new number"). The
    // confirmation-tracker downstream does its own drift check against
    // the bet-history feed, but this log lets us see it immediately in
    // the audit trail rather than waiting 30s+ for the feed pass.
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

  // 7. Persist + notify — DB write ONLY when the book accepts the bet.
  if (attempt.status === "placed" || attempt.status === "pending") {
    // 7a. Confirmation-required providers (9W Sportsbook):
    //     DON'T persist to the DB yet. Hand off to the confirmation
    //     tracker — it polls the book's bet-history feed every 30s for
    //     up to 2 minutes, writes the row (and fires Telegram) once a
    //     matching ticket appears, or sends a failure Telegram and
    //     drops if the deadline elapses without a match. This makes
    //     the provider's bet-history feed the source of truth instead
    //     of the book's raw placement response.
    if (CONFIRMATION_REQUIRED_PROVIDERS.has(providerId)) {
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
        bookedOdds: attempt.bookedOdds ?? odds,
        evPct: computeEvPctSafe(valueBet, attempt.bookedOdds ?? odds),
        marketId: extractRefString(providerRefs, "marketId"),
        selectionId: extractRefNumber(providerRefs, "selectionId"),
        betfairEventId: extractRefNumber(providerRefs, "betfairEventId"),
        timeScope: valueBet.timeScope,
        familyLine:
          valueBet.familyLine !== null && valueBet.familyLine !== undefined
            ? String(valueBet.familyLine)
            : null,
        gradeUrl: buildBetGradeUrl({
          homeTeam: valueBet.homeTeam,
          awayTeam: valueBet.awayTeam,
          competition: valueBet.competition,
          eventStartTime: valueBet.eventStartTime,
          marketType: valueBet.marketType,
          timeScope: valueBet.timeScope,
          familyLine: valueBet.familyLine,
          atomLabel: valueBet.atomLabel,
        }),
        dashboardUrl: appUrl ? `${appUrl}/dashboard` : undefined,
        ticketIdHint: attempt.ticketId ?? null,
        balanceAtSubmit: accountInfo.balance,
      } as const;
      if (isVelki) {
        velkiRegisterPendingConfirmation(confirmPayload);
      } else {
        nwRegisterPendingConfirmation(confirmPayload);
      }
      return {
        status: "pending",
        placedBetId: placementId,
        bookedOdds: attempt.bookedOdds ?? odds,
        stake,
        ticketId: attempt.ticketId,
      };
    }

    const isPending = attempt.status === "pending";
    let row;
    try {
      // In merged schema, the row already exists (persisted by value detector).
      // insertPlacedBet will find it by id and update placement fields.
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
        odds: attempt.bookedOdds ?? odds,
        currency: baseInsert.currency,
        providerTicketId: attempt.ticketId ?? null,
        mode,

      });
    } catch (err) {
      // UNIQUE-index collision on (event_id, family_id, atom_id): another
      // caller already wrote a row for this selection (race slipped past
      // the in-process inflight lock, e.g. after HMR or a second worker).
      // The book likely deduplicated our submission against the first
      // request and returned the same ticket; the first row is the
      // authoritative one. Don't write a second row and don't fire a
      // second Telegram — just return skipped so callers noop.
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

    // For pending placements, tag the DB row so a later reconciliation
    // job can find it and attach a ticket id from myBets.
    if (isPending) {
      logger.info(
        "BetPlacer",
        `bet accepted by ${adapter.providerDisplayName} but still processing ` +
          `(ticket ${attempt.ticketId ?? "n/a"}) — will reconcile via myBets`,
      );
    }

    // Telegram notify — ONLY on confirmed placements. Pending
    // placements (book accepted but still processing) are notified
    // later by the reconciler once a matching ticket appears in
    // myBets. This avoids false-positive "Bet placed" pings that
    // could turn into silent rejections a few seconds later.
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
        gradeUrl: buildBetGradeUrl({
          homeTeam: valueBet.homeTeam,
          awayTeam: valueBet.awayTeam,
          competition: valueBet.competition,
          eventStartTime: valueBet.eventStartTime,
          marketType: valueBet.marketType,
          timeScope: valueBet.timeScope,
          familyLine: valueBet.familyLine,
          atomLabel: valueBet.atomLabel,
        }),
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

  // Rejection or error — no DB write. Still notify so the UI surfaces it.
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

  // Book rejected / errored — release the reservation so the next
  // valid sync cycle can retry this selection.
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

/**
 * Bucket the book's raw error string into a stable category so the
 * notifier can pick an icon / label without string-matching, and ops
 * can aggregate failures by cause. Falls back to `book_rejection` /
 * `adapter_error` based on which status the adapter returned.
 */
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

// Best-effort sport inference from competition name. The events store
// has a sport slug but it isn't on the value_bets row — this fallback
// gives us the right emoji most of the time.
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
