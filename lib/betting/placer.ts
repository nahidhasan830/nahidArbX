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
  isAlreadyPlaced,
} from "@/lib/db/repositories/placed-bets";
import { notify } from "@/lib/notifier";
import { logger } from "@/lib/shared/logger";
import { buildBetGradeUrl } from "@/lib/shared/google-ai-link";
import { getMarketLimits as getCachedMarketLimits } from "@/lib/atoms/market-limits-store";
import { getBettingSettings } from "@/lib/db/repositories/betting-settings";
import { computeStakeBdt, deriveEdgeForRow } from "./strategy";
import { MIN_EV_PCT } from "@/lib/shared/constants";
import {
  hasPendingConfirmation,
  newPlacementId,
  registerPendingConfirmation,
} from "@/lib/betting/ninewickets/placement-confirmation";
import type { ProviderKey } from "@/lib/atoms/types";
import type { ValueBetRow } from "@/lib/db/schema";

/**
 * Providers whose "placed" / "pending" book responses must be verified
 * against the provider's bet-history feed before we persist to the DB.
 * Today this is 9W Sportsbook only — see
 * [placement-confirmation.ts](../ninewickets/placement-confirmation.ts)
 * for the rationale and polling protocol.
 */
const CONFIRMATION_REQUIRED_PROVIDERS = new Set<string>([
  "ninewickets-sportsbook",
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
    }
  | {
      /** Book rejected on a business rule. Not persisted to DB. */
      status: "rejected";
      reason: string;
    }
  | {
      /** Transport / auth / parse failure. Not persisted to DB. */
      status: "error";
      reason: string;
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
    return Promise.resolve({
      status: "skipped",
      reason: "Placement already in flight for this selection",
    });
  }
  const promise = placeBetForValueBetImpl(args).finally(() => {
    inflightPlacements.delete(key);
  });
  inflightPlacements.set(key, promise);
  return promise;
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

  // 1. Dedup — cross-provider lifetime.
  if (
    await isAlreadyPlaced(valueBet.eventId, valueBet.familyId, valueBet.atomId)
  ) {
    return {
      status: "skipped",
      reason: "Already placed for this (event, market, selection)",
    };
  }

  // 1b. In-flight-confirmation dedup.
  //
  // 9W Sportsbook placements are held in-memory for up to 2 minutes
  // while we poll the book's bet-history feed to confirm they actually
  // landed. During that window no `placed_bets` row exists yet, so the
  // DB-backed check above can't see them — we have to consult the
  // confirmation tracker separately. Without this guard a second
  // auto-place tick (or a retry from the UI) would re-submit the same
  // selection while the first is still being verified, and both would
  // fire once the book deduplicates server-side.
  if (
    CONFIRMATION_REQUIRED_PROVIDERS.has(providerId) &&
    hasPendingConfirmation(valueBet.eventId, valueBet.familyId, valueBet.atomId)
  ) {
    return {
      status: "skipped",
      reason:
        "Placement already in flight for this selection (awaiting book confirmation)",
    };
  }

  // 2. Auto-place toggle — manual bypasses this.
  if (mode === "auto" && !isAutoPlaceEnabled(providerId)) {
    return {
      status: "skipped",
      reason: `Auto-place disabled for ${adapter.providerDisplayName}`,
    };
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
    };
  }

  // 4. Account state.
  let accountInfo;
  try {
    accountInfo = await adapter.getAccountInfo();
  } catch (err) {
    return {
      status: "error",
      reason: `Account info fetch failed: ${msg(err)}`,
    };
  }
  if (accountInfo.suspended) {
    return { status: "skipped", reason: "Account suspended by book" };
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
    const { evPct, fullKelly } = deriveEdgeForRow({
      softOddsLast: Number(valueBet.softOddsLast),
      softCommissionPct: Number(valueBet.softCommissionPct),
      sharpTrueProb: Number(valueBet.sharpTrueProb),
    });
    // Hard EV floor at placement time. The detector only emits value bets
    // above MIN_EV_PCT, but the DB row can decay between detection and
    // placement — softOddsLast is refreshed every tick while sharpTrueProb
    // and softCommissionPct may update independently, so the placer must
    // recheck against its own snapshot instead of trusting the detector's
    // earlier verdict. Without this guard, "flat" strategy (which ignores
    // Kelly) places unitSize on anything, and Kelly strategies clamp a
    // zero-Kelly stake up to the book floor instead of skipping.
    if (evPct < MIN_EV_PCT) {
      return {
        status: "skipped",
        reason: `EV decayed to ${evPct.toFixed(2)}% (< ${MIN_EV_PCT}% floor): softOddsLast=${valueBet.softOddsLast}, sharpTrueProb=${Number(valueBet.sharpTrueProb).toFixed(4)}, comm=${valueBet.softCommissionPct}%`,
      };
    }
    const rawStake = computeStakeBdt({
      strategyId: settings.strategyId as import("./strategy").StrategyId,
      fullKellyFraction: fullKelly,
      evPct,
      bankrollBdt: bankroll,
      unitSizeBdt: settings.unitSizeBdt,
      kellyCapPct: settings.kellyCapPct,
    });
    // Snap-down-to-bucket then clamp-up-to-floor. Book min and the
    // operator-chosen floor both matter: max(bookMin, settings floor).
    const bucket = settings.stakeBucketBdt;
    const autoMinStake = snapUp(Math.max(minBet, settings.minStakeBdt), bucket);
    if (autoMinStake > accountInfo.balance) {
      return {
        status: "skipped",
        reason: `Auto-place floor ${autoMinStake} exceeds balance ${accountInfo.balance}`,
      };
    }
    let snapped = snapDown(rawStake, bucket);
    if (snapped < autoMinStake) snapped = autoMinStake;
    logger.info(
      "BetPlacer",
      `auto [${settings.strategyId}]: raw=${rawStake.toFixed(2)} → ` +
        `snapped=${snapped} (bucket=${bucket}, floor=${autoMinStake}, ` +
        `bookMin=${minBet}, bankroll=${bankroll}, evPct=${evPct.toFixed(2)}, ` +
        `kelly=${fullKelly.toFixed(4)})`,
    );
    targetStake = snapped;
  } else {
    targetStake = round2(args.kellyStake);
    if (targetStake < minBet) {
      return {
        status: "skipped",
        reason: `Kelly stake ${targetStake} below book minimum ${minBet}`,
      };
    }
  }
  if (targetStake > accountInfo.balance) {
    return {
      status: "skipped",
      reason: `Insufficient balance: need ${targetStake}, have ${accountInfo.balance}`,
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
      };
    }
  }
  const odds = Number(valueBet.softOddsLast);

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
  const attempt = await adapter.placeBet({
    providerRefs,
    stake,
    odds,
    currency: adapter.currency,
  });
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
    requestPayload: attempt.request,
    responsePayload: attempt.response,
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
      const placementId = newPlacementId();
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
      registerPendingConfirmation({
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
        requestPayload: attempt.request,
        responsePayload: attempt.response,
        ticketIdHint: attempt.ticketId ?? null,
        balanceAtSubmit: accountInfo.balance,
      });
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
      row = await insertPlacedBet({
        ...baseInsert,
        odds: attempt.bookedOdds ?? odds,
        providerTicketId: attempt.ticketId ?? null,
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
        at: row.placedAt,
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
