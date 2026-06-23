/**
 * 9W Sportsbook post-placement confirmation tracker.
 *
 * The book's geniusSportsBet endpoint returns one of two success shapes:
 *   1. SUCCESS + ticketId  — bet confirmed synchronously
 *   2. SUCCESS / PENDING / PROCESSING (often with isPending=true) —
 *      book accepted the request but is still matching it in the
 *      background; ticket id arrives later.
 *
 * Either way, the ONLY source of truth is the book's own bet-history
 * feed (queryUnMatchTicketsAndTxns). A "SUCCESS" response without a
 * corresponding entry in the feed within a reasonable window almost
 * always means the bet silently dropped (WAF, network, book-side
 * rejection), so we treat the feed as authoritative:
 *
 *   - Hold the placement in memory after submission (no DB write).
 *   - Poll the feed every {@link POLL_INTERVAL_MS} for up to
 *     {@link DEADLINE_MS}.
 *   - When we see a matching ticket (stake + odds + marketId +
 *     selectionId), insert the unified `bets` row with the real
 *     ticket id and fire the Telegram `bet:placed` notification.
 *   - If the deadline elapses with no match, fire a Telegram
 *     `bet:error` notification and drop — no DB row.
 *
 * Race-condition protection: while a confirmation is pending the
 * placer consults {@link hasPendingConfirmation} in addition to the
 * DB-backed `isAlreadyPlaced`. That prevents a second auto-place tick
 * from re-submitting the same (event, market, selection) during the
 * confirmation window.
 *
 * State lives on `globalThis` so the tracker survives Next.js HMR in
 * dev; a fresh module instance reuses the same Map.
 */
import { randomUUID } from "node:crypto";
import {
  insertPlacedBet,
  DuplicatePlacedBetError,
  type NewPlacedBetInput,
} from "@/lib/db/repositories/bets";
import { notify } from "@/lib/notifier";
import { logger } from "@/lib/shared/logger";
import { computeModelEdgePctAtOdds } from "@/lib/ml/staker";
import { queryPlayerInfo } from "./client";
import { fetchUnMatchedTickets } from "./reconciler";
import type { GeniusSportsUnMatchTicket } from "./types";

const PROVIDER = "ninewickets-sportsbook";
const POLL_INTERVAL_MS = 30_000;
const DEADLINE_MS = 2 * 60 * 1000;
/** Clock-skew buffer when matching createDate ≥ submittedAt. */
const CLOCK_SKEW_MS = 5_000;
/** Fraction of stake that must be missing from `betCredit` for us to
 *  treat it as "the book took the money". Anything >= this triggers a
 *  one-shot deadline extension so a slow-to-surface ticket still has a
 *  chance to reconcile instead of getting falsely flagged as dropped. */
const BALANCE_DELTA_TOLERANCE = 0.9;

/**
 * Everything we need to (a) match the ticket when it appears and
 * (b) write the final DB row + telegram notification. Populated by
 * the placer at submission time.
 */
export interface PendingConfirmation {
  /** UUID reserved for the eventual `bets.id`. Returned to the caller synchronously. */
  placementId: string;

  // Bet identity
  valueBetId: string | null;
  eventId: string;
  familyId: string;
  atomId: string;
  atomLabel: string;
  eventName: string;
  competition: string | null;
  sport: string | null;
  eventStartTime: string;
  marketType: string;

  // Provider + display
  provider: string;
  providerDisplayName: string;
  currency: string;
  mode: "auto" | "manual";

  // Numbers
  stake: number;
  bookedOdds: number;
  softCommissionPct: number;
  evPct?: number;
  kellyFraction?: number;
  placedMlScore: number | null;
  placedMlModelEdgePct: number | null;
  placedMlDecision: string | null;
  placedMlKellyMultiplier: number | null;
  placedMlModelVersion: number | null;
  placedMlFeatures: number[] | null;
  placedMlFeatureVersion: number | null;
  placedMlFeatureCount: number | null;
  placedMlFeatureNamesHash: string | null;

  // Market ref fields used for matching
  marketId: string | null;
  selectionId: number | null;
  betfairEventId: number | null;

  // Telegram context
  timeScope: string | null;
  familyLine: string | null;
  dashboardUrl?: string;

  /** Ticket id returned synchronously, if any. Used as a match short-circuit. */
  ticketIdHint: string | null;

  // Timing
  submittedAt: number;
  deadlineAt: number;

  /** `betCredit` observed just before the book accepted the submission.
   *  Used at timeout to decide whether the book actually reserved the
   *  stake — if so we extend the window once instead of declaring the
   *  bet dropped. `null` if the placer couldn't capture it. */
  balanceAtSubmit: number | null;
  /** Set to true the first (and only) time we extend `deadlineAt`
   *  because the post-timeout balance re-check showed the stake was
   *  deducted. Prevents unbounded extension loops. */
  extendedOnce: boolean;
}

interface TrackerState {
  /** key = `${eventId}|${familyId}|${atomId}` */
  pending: Map<string, PendingConfirmation>;
  pollerHandle: ReturnType<typeof setInterval> | null;
  /** Set when a poll tick is currently running — prevents overlap. */
  polling: boolean;
}

const STATE_KEY = Symbol.for("nahidarbx.placement-confirmation.state");
type GlobalWithState = typeof globalThis & { [STATE_KEY]?: TrackerState };

function getState(): TrackerState {
  const g = globalThis as GlobalWithState;
  let s = g[STATE_KEY];
  if (!s) {
    s = { pending: new Map(), pollerHandle: null, polling: false };
    g[STATE_KEY] = s;
  }
  return s;
}

function keyFor(eventId: string, familyId: string, atomId: string): string {
  return `${eventId}|${familyId}|${atomId}`;
}

/** True iff a confirmation is in flight for this selection. */
export function hasPendingConfirmation(
  eventId: string,
  familyId: string,
  atomId: string,
): boolean {
  return getState().pending.has(keyFor(eventId, familyId, atomId));
}

/**
 * Look up an in-flight confirmation by the placementId returned to the
 * caller at submission time. Used by the frontend's pending-bet poller
 * to tell the difference between "still being matched" and "dropped
 * silently by the book" (neither this nor the DB row shows up → timed
 * out).
 */
export function getPendingConfirmationByPlacementId(
  placementId: string,
): PendingConfirmation | null {
  for (const attempt of getState().pending.values()) {
    if (attempt.placementId === placementId) return attempt;
  }
  return null;
}

/**
 * Build a fresh placement id. The placer calls this BEFORE submitting
 * to the book so the id is stable across "in-flight" and "confirmed"
 * states — it's what we return to the caller synchronously AND use as
 * `placed_bets.id` once confirmed.
 */
export function newPlacementId(): string {
  return randomUUID();
}

/**
 * Register a placement as pending confirmation. Starts the poller if
 * it's not already running. Returns the `placementId` so the caller
 * can correlate the eventual DB row with what it saw at submission.
 */
export function registerPendingConfirmation(
  attempt: Omit<
    PendingConfirmation,
    "submittedAt" | "deadlineAt" | "extendedOnce"
  >,
): void {
  const state = getState();
  const now = Date.now();
  const full: PendingConfirmation = {
    ...attempt,
    submittedAt: now,
    deadlineAt: now + DEADLINE_MS,
    extendedOnce: false,
  };
  const k = keyFor(attempt.eventId, attempt.familyId, attempt.atomId);
  state.pending.set(k, full);
  logger.info(
    "PlacementConfirmation",
    `tracking ${k} (stake=${attempt.stake}@${attempt.bookedOdds}, ` +
      `ticketHint=${attempt.ticketIdHint ?? "none"}, ` +
      `deadline=${new Date(full.deadlineAt).toISOString()})`,
  );
  ensurePollerRunning();
  // Kick off an immediate check so bets that already surfaced in the
  // feed get confirmed fast instead of waiting a full interval.
  void tick("registration");
}

/**
 * Lazily-started interval poller. Only runs while there are pending
 * confirmations — idle state means the Node process can exit cleanly
 * (the timer is also `.unref()`'d as a belt-and-braces).
 */
function ensurePollerRunning(): void {
  const state = getState();
  if (state.pollerHandle) return;
  state.pollerHandle = setInterval(() => {
    void tick("interval");
  }, POLL_INTERVAL_MS);
  // unref so the timer doesn't keep the process alive when idle.
  // (In dev Next.js holds the process alive anyway; in prod this
  // matters for clean shutdowns.)
  if (typeof state.pollerHandle.unref === "function") {
    state.pollerHandle.unref();
  }
}

function stopPollerIfIdle(): void {
  const state = getState();
  if (state.pending.size === 0 && state.pollerHandle) {
    clearInterval(state.pollerHandle);
    state.pollerHandle = null;
  }
}

/**
 * One pass through all pending confirmations. Shared feed fetch so we
 * only hit the book's endpoint once per tick regardless of how many
 * confirmations are pending.
 */
async function tick(source: "interval" | "registration"): Promise<void> {
  const state = getState();
  if (state.polling) return;
  if (state.pending.size === 0) {
    stopPollerIfIdle();
    return;
  }
  state.polling = true;
  try {
    let tickets: GeniusSportsUnMatchTicket[] = [];
    try {
      const feed = await fetchUnMatchedTickets();
      tickets = feed.geniusSportsUnMatchTickets ?? [];
    } catch (err) {
      // One failed feed fetch is recoverable — we'll try again next
      // tick. Only the final deadline check can turn this into a
      // reported failure, so log + carry on.
      logger.warn(
        "PlacementConfirmation",
        `fetchUnMatchedTickets failed (${source} tick): ` +
          (err instanceof Error ? err.message : String(err)),
      );
      // Don't abort — we still want to age out past-deadline entries.
    }

    // A single ticket in the feed must never satisfy two pending
    // confirmations at once (defensive — the unique dedup index on
    // placed_bets also protects against this at insert time).
    const claimedTicketIds = new Set<string>();
    const now = Date.now();

    for (const [k, attempt] of Array.from(state.pending.entries())) {
      const match = findMatchingTicket(tickets, attempt, claimedTicketIds);
      if (match) {
        claimedTicketIds.add(String(match.id));
        state.pending.delete(k);
        await finaliseConfirmed(attempt, match).catch((err) => {
          logger.error(
            "PlacementConfirmation",
            `finaliseConfirmed failed for ${k}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
        continue;
      }
      if (now >= attempt.deadlineAt) {
        // Before declaring this bet dropped, peek at the book's balance.
        // If `betCredit` fell by roughly the stake between submission
        // and now, the book DID reserve the money — the ticket is just
        // slow to surface in the feed. Extend the window once; on the
        // second timeout we give up regardless so we never loop forever.
        const balanceCheck = await maybeExtendOnBalanceDelta(attempt).catch(
          (err) => {
            logger.warn(
              "PlacementConfirmation",
              `balance recheck failed for ${k}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
            return { extended: false, balanceDeducted: null } as const;
          },
        );
        if (balanceCheck.extended) {
          // Mutate in-place — the entry stays in `pending` and the next
          // poll tick will try to match again against a fresh feed.
          continue;
        }
        state.pending.delete(k);
        await finaliseTimedOut(attempt, balanceCheck.balanceDeducted).catch(
          (err) => {
            logger.error(
              "PlacementConfirmation",
              `finaliseTimedOut failed for ${k}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          },
        );
      }
    }
  } finally {
    state.polling = false;
    stopPollerIfIdle();
  }
}

function findMatchingTicket(
  tickets: GeniusSportsUnMatchTicket[],
  attempt: PendingConfirmation,
  claimed: Set<string>,
): GeniusSportsUnMatchTicket | null {
  // Fast path: the adapter gave us a ticket id up-front — trust it if
  // we see it in the feed, regardless of the other match fields.
  if (attempt.ticketIdHint) {
    for (const t of tickets) {
      if (claimed.has(String(t.id))) continue;
      if (String(t.id) === attempt.ticketIdHint) return t;
    }
  }

  const stakeEq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const submittedMs = attempt.submittedAt;

  // Drop the odds-equality requirement from the match. The feed's
  // `odds` is the book's BOOKED odds — what actually got placed — and
  // may differ from `attempt.bookedOdds` (the value in the placement
  // response) or from the odds we originally asked for. If we force
  // an exact odds match here, a real placement with shifted odds
  // never reconciles, the 2-minute deadline lapses, and the operator
  // gets a false "lost bet" alert. Instead we match on
  // (marketId, selectionId, stake, createDate ≥ submittedAt) and let
  // `finaliseConfirmed` compare the booked odds afterwards so it can
  // surface any drift explicitly. Multiple candidates pointing at the
  // same (market, selection, stake) tie-break on smallest createDate
  // delta so we always latch onto the bet we just placed rather than
  // an older ticket with the same three fields.
  let best: GeniusSportsUnMatchTicket | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const t of tickets) {
    if (claimed.has(String(t.id))) continue;
    if (attempt.selectionId !== null && t.selectionId !== attempt.selectionId) {
      continue;
    }
    if (attempt.marketId !== null && String(t.marketId) !== attempt.marketId) {
      continue;
    }
    if (!stakeEq(t.initPrice, attempt.stake)) continue;
    if (t.createDate < submittedMs - CLOCK_SKEW_MS) continue;
    const delta = Math.abs(t.createDate - submittedMs);
    if (delta < bestDelta) {
      best = t;
      bestDelta = delta;
    }
  }
  if (best) return best;

  // Loose fallback: (event, stake) within the submission window. Used
  // when the placer didn't preserve marketId / selectionId (e.g. refs
  // came pre-resolved from an older runtime path). Requires
  // betfairEventId so we don't cross-match unrelated selections.
  if (attempt.betfairEventId !== null) {
    for (const t of tickets) {
      if (claimed.has(String(t.id))) continue;
      const sameEvent =
        (t as { mappingEventId?: number }).mappingEventId ===
          attempt.betfairEventId || t.eventId === attempt.betfairEventId;
      if (!sameEvent) continue;
      if (!stakeEq(t.initPrice, attempt.stake)) continue;
      if (t.createDate < submittedMs - CLOCK_SKEW_MS) continue;
      return t;
    }
  }
  return null;
}

/** Material odds drift threshold (absolute decimal-odds difference).
 *  Anything bigger than this between what we asked for / what the book
 *  said it booked / what the feed shows gets flagged so the operator
 *  can investigate — typical price-movement on a sportsbook is well
 *  below 0.02. */
const ODDS_DRIFT_THRESHOLD = 0.02;

async function finaliseConfirmed(
  attempt: PendingConfirmation,
  ticket: GeniusSportsUnMatchTicket,
): Promise<void> {
  const ticketId = String(ticket.id);

  // The provider's bet-history feed is the authoritative record of
  // what ACTUALLY got placed. Use its stake + odds for the DB row and
  // the Telegram notification; compare against the placement-response
  // values so any drift is visible to the operator.
  //
  //   attempt.bookedOdds = what `placeBet` response said the book had
  //                        accepted at submission time.
  //   ticket.odds        = what the feed now shows for the same ticket.
  //                        If these diverge (price moved between the
  //                        response and the matched record, or the
  //                        adapter misparsed the response), this is
  //                        the number that determines payout.
  const authoritativeStake = ticket.initPrice;
  const authoritativeOdds = ticket.odds;
  const placedMlModelEdgePct =
    attempt.placedMlScore == null
      ? null
      : computeModelEdgePctAtOdds(
          attempt.placedMlScore,
          authoritativeOdds,
          attempt.softCommissionPct,
        );
  const oddsDrift = Math.abs(authoritativeOdds - attempt.bookedOdds);
  const stakeDrift = Math.abs(authoritativeStake - attempt.stake);
  const driftAlert =
    oddsDrift > ODDS_DRIFT_THRESHOLD || stakeDrift > 0.01
      ? {
          oddsDrift,
          stakeDrift,
          requestedOdds: attempt.bookedOdds,
          actualOdds: authoritativeOdds,
          requestedStake: attempt.stake,
          actualStake: authoritativeStake,
        }
      : null;

  const insertInput: NewPlacedBetInput = {
    id: attempt.placementId,
    eventId: attempt.eventId,
    familyId: attempt.familyId,
    atomId: attempt.atomId,
    atomLabel: attempt.atomLabel,
    homeTeam: attempt.eventName,
    awayTeam: "",
    competition: attempt.competition,
    eventStartTime: attempt.eventStartTime,
    marketType: attempt.marketType,
    timeScope: attempt.timeScope ?? "match",
    familyLine: attempt.familyLine != null ? Number(attempt.familyLine) : null,
    sharpProvider: "pinnacle",
    sharpOdds: attempt.bookedOdds,
    sharpTrueProb: 0.5,
    softProvider: attempt.provider,
    softCommissionPct: attempt.softCommissionPct,
    softOdds: authoritativeOdds,
    provider: attempt.provider,
    stake: authoritativeStake,
    odds: authoritativeOdds,
    currency: attempt.currency,
    providerTicketId: ticketId,
    mode: attempt.mode,
    placedMlScore: attempt.placedMlScore,
    placedMlModelEdgePct,
    placedMlDecision: attempt.placedMlDecision,
    placedMlKellyMultiplier: attempt.placedMlKellyMultiplier,
    placedMlModelVersion: attempt.placedMlModelVersion,
    placedMlFeatures: attempt.placedMlFeatures,
    placedMlFeatureVersion: attempt.placedMlFeatureVersion,
    placedMlFeatureCount: attempt.placedMlFeatureCount,
    placedMlFeatureNamesHash: attempt.placedMlFeatureNamesHash,
  };

  try {
    const row = await insertPlacedBet(insertInput);
    logger.info(
      "PlacementConfirmation",
      `confirmed ${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
        `ticket=${ticketId} (${Math.round((Date.now() - attempt.submittedAt) / 1000)}s after submission)`,
    );
    if (driftAlert) {
      logger.warn(
        "PlacementConfirmation",
        `odds/stake drift detected on ticket ${ticketId}: ` +
          `requested ${driftAlert.requestedStake}@${driftAlert.requestedOdds} → ` +
          `booked ${driftAlert.actualStake}@${driftAlert.actualOdds} ` +
          `(Δodds=${driftAlert.oddsDrift.toFixed(3)}, Δstake=${driftAlert.stakeDrift.toFixed(2)})`,
      );
      // Surface to the operator so they know the booked price differs
      // from what our placement response said. This doesn't block the
      // bet — it's already placed — but it flags the discrepancy so
      // downstream P&L / CLV reports can be interpreted correctly.
      await notify({
        type: "system",
        at: new Date().toISOString(),
        severity: "warn",
        message:
          `Odds drift · ${driftAlert.actualOdds < driftAlert.requestedOdds ? "worse" : "better"}\n` +
          `${attempt.eventName}\n` +
          `${attempt.atomLabel} ${driftAlert.requestedStake}@${driftAlert.requestedOdds} → ${driftAlert.actualOdds}\n` +
          `Ticket ${ticketId}`,
      }).catch(() => {
        // Best effort — drift detection is not worth a second failure.
      });
    }
    await notify({
      type: "bet:placed",
      at: row.placedAt ?? new Date().toISOString(),
      provider: attempt.provider,
      providerDisplayName: attempt.providerDisplayName,
      eventName: attempt.eventName,
      competition: attempt.competition,
      sport: attempt.sport,
      eventStartTime: attempt.eventStartTime,
      marketName: attempt.marketType,
      selectionName: attempt.atomLabel,
      stake: authoritativeStake,
      odds: authoritativeOdds,
      currency: attempt.currency,
      mode: attempt.mode,
      evPct: attempt.evPct,
      kellyFraction: attempt.kellyFraction,
      timeScope: attempt.timeScope,
      familyLine: attempt.familyLine,
      ticketId,
      balance:
        attempt.balanceAtSubmit != null
          ? attempt.balanceAtSubmit - authoritativeStake
          : undefined,
      dashboardUrl: attempt.dashboardUrl,
    });
  } catch (err) {
    if (err instanceof DuplicatePlacedBetError) {
      // Under the reservation model, this means the reservation row
      // was missing when we tried to patch in ticket/stake/odds — i.e.
      // something released or never created it. This shouldn't happen
      // in the happy path (placer always reserves before submitting),
      // so log loudly. The book ticket still exists; operator must
      // reconcile manually.
      logger.error(
        "PlacementConfirmation",
        `confirm ${attempt.eventId}|${attempt.familyId}|${attempt.atomId}: ` +
          `reservation row missing when attaching ticket ${ticketId} — ` +
          `book accepted but no DB row to patch. Manual reconciliation required.`,
      );
      return;
    }
    // Any other insertPlacedBet failure (schema validation, unexpected
    // DB error). Without this log the operator would see a Telegram
    // "Bet Placed" fire for some other code path while no row exists
    // in DB — exactly the mystery that made 2026-04-24's three
    // duplicate placements (tickets 11057135/39/42) so hard to trace.
    logger.error(
      "PlacementConfirmation",
      `finaliseConfirmed insertPlacedBet failed for ` +
        `${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
        `(ticket ${ticketId}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    throw err;
  }
}

/**
 * Post-timeout balance probe. Returns `extended: true` exactly once per
 * pending confirmation — when the observed betCredit drop matches the
 * stake. In that case it bumps `deadlineAt` by another DEADLINE_MS and
 * sets `extendedOnce` so the next timeout fires through to
 * `finaliseTimedOut` regardless. `balanceDeducted` is included in the
 * non-extended return so the caller can label the error correctly.
 */
async function maybeExtendOnBalanceDelta(
  attempt: PendingConfirmation,
): Promise<{ extended: boolean; balanceDeducted: boolean | null }> {
  // No snapshot → we can't tell. Fall through to the old behaviour.
  if (attempt.balanceAtSubmit === null) {
    return { extended: false, balanceDeducted: null };
  }
  // Already extended once → don't extend again no matter what.
  if (attempt.extendedOnce) {
    // Still compute deduction for the telegram copy.
    const info = await queryPlayerInfo();
    const drop = attempt.balanceAtSubmit - info.betCredit;
    const deducted = drop >= attempt.stake * BALANCE_DELTA_TOLERANCE;
    return { extended: false, balanceDeducted: deducted };
  }
  const info = await queryPlayerInfo();
  const drop = attempt.balanceAtSubmit - info.betCredit;
  const deducted = drop >= attempt.stake * BALANCE_DELTA_TOLERANCE;
  if (!deducted) {
    return { extended: false, balanceDeducted: false };
  }
  attempt.extendedOnce = true;
  attempt.deadlineAt = Date.now() + DEADLINE_MS;
  logger.warn(
    "PlacementConfirmation",
    `extend ${attempt.eventId}|${attempt.familyId}|${attempt.atomId}: ` +
      `betCredit dropped ${drop.toFixed(2)} (≈ stake ${attempt.stake}) — ` +
      `waiting another ${Math.round(DEADLINE_MS / 1000)}s for ticket to surface`,
  );
  return { extended: true, balanceDeducted: true };
}

async function finaliseTimedOut(
  attempt: PendingConfirmation,
  balanceDeducted: boolean | null,
): Promise<void> {
  const ageSec = Math.round((Date.now() - attempt.submittedAt) / 1000);
  logger.warn(
    "PlacementConfirmation",
    `timeout ${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
      `after ${ageSec}s — no matching ticket in book feed; no DB write ` +
      `(balanceDeducted=${balanceDeducted})`,
  );
  const errorMsg =
    balanceDeducted === true
      ? `Book reserved the stake (balance dropped by ~${attempt.stake} ${attempt.currency}) ` +
        `but no ticket surfaced in the bet-history feed within ${ageSec}s. ` +
        `Money is almost certainly on a live ticket — reconcile manually in 9W.`
      : balanceDeducted === false
        ? `Book accepted the submission but balance was NOT deducted and no ticket ` +
          `appeared in the bet-history feed within ${ageSec}s. ` +
          `Bet was silently dropped (WAF / book-side reject). Not persisted.`
        : `Book accepted the submission but the bet never appeared in the provider's ` +
          `bet-history feed within ${ageSec}s. ` +
          `Not persisted to DB. Check 9W directly to confirm placement status.`;
  await notify({
    type: "bet:error",
    at: new Date().toISOString(),
    provider: attempt.provider,
    providerDisplayName: attempt.providerDisplayName,
    eventName: attempt.eventName,
    competition: attempt.competition,
    sport: attempt.sport,
    eventStartTime: attempt.eventStartTime,
    marketName: attempt.marketType,
    selectionName: attempt.atomLabel,
    timeScope: attempt.timeScope,
    familyLine: attempt.familyLine,
    error: errorMsg,
    reasonCategory: "transport",
    mode: attempt.mode,
    stake: attempt.stake,
    odds: attempt.bookedOdds,
    currency: attempt.currency,
    evPct: attempt.evPct,
    kellyFraction: attempt.kellyFraction,
    dashboardUrl: attempt.dashboardUrl,
  });
}

// --------------------------------------------------------------------
// Test / diagnostics hooks — not exported broadly, only used by the
// `/api/providers/9w/overview` route if we later want to surface
// in-flight confirmations to the dashboard.
// --------------------------------------------------------------------

/** Snapshot of in-flight placements — for diagnostics / dashboard. */
export function listPendingConfirmations(): PendingConfirmation[] {
  return Array.from(getState().pending.values());
}

/** Provider the tracker is specific to. Exposed for tests. */
export const CONFIRMATION_PROVIDER = PROVIDER;
