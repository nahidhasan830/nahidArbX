/**
 * Velki Sportsbook post-placement confirmation tracker.
 *
 * Symmetric counterpart to
 * {@link ../ninewickets/placement-confirmation.ts}. Both providers run
 * the same Genius Sports platform — the endpoint shapes, response
 * semantics, and bet-history feed are identical. Only the host, auth,
 * and currency-unit scale differ.
 *
 * See the 9W module's header comment for the full rationale on why we
 * poll the bet-history feed rather than trusting the placement response.
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
import type { GeniusSportsUnMatchTicket } from "../ninewickets/types";

const PROVIDER = "velki-sportsbook";
const POLL_INTERVAL_MS = 30_000;
const DEADLINE_MS = 2 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const BALANCE_DELTA_TOLERANCE = 0.9;

export interface PendingConfirmation {
  placementId: string;
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
  provider: string;
  providerDisplayName: string;
  currency: string;
  mode: "auto" | "manual";
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
  marketId: string | null;
  selectionId: number | null;
  betfairEventId: number | null;
  timeScope: string | null;
  familyLine: string | null;
  dashboardUrl?: string;

  ticketIdHint: string | null;
  submittedAt: number;
  deadlineAt: number;
  balanceAtSubmit: number | null;
  extendedOnce: boolean;
}

interface TrackerState {
  pending: Map<string, PendingConfirmation>;
  pollerHandle: ReturnType<typeof setInterval> | null;
  polling: boolean;
}

const STATE_KEY = Symbol.for("nahidarbx.velki-placement-confirmation.state");
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

export function hasPendingConfirmation(
  eventId: string,
  familyId: string,
  atomId: string,
): boolean {
  return getState().pending.has(keyFor(eventId, familyId, atomId));
}

export function getPendingConfirmationByPlacementId(
  placementId: string,
): PendingConfirmation | null {
  for (const attempt of getState().pending.values()) {
    if (attempt.placementId === placementId) return attempt;
  }
  return null;
}

export function newPlacementId(): string {
  return randomUUID();
}

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
    "Velki.PlacementConfirmation",
    `tracking ${k} (stake=${attempt.stake}@${attempt.bookedOdds}, ` +
      `ticketHint=${attempt.ticketIdHint ?? "none"}, ` +
      `deadline=${new Date(full.deadlineAt).toISOString()})`,
  );
  ensurePollerRunning();
  void tick("registration");
}

function ensurePollerRunning(): void {
  const state = getState();
  if (state.pollerHandle) return;
  state.pollerHandle = setInterval(() => {
    void tick("interval");
  }, POLL_INTERVAL_MS);
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
      logger.warn(
        "Velki.PlacementConfirmation",
        `fetchUnMatchedTickets failed (${source} tick): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    const claimedTicketIds = new Set<string>();
    const now = Date.now();

    for (const [k, attempt] of Array.from(state.pending.entries())) {
      const match = findMatchingTicket(tickets, attempt, claimedTicketIds);
      if (match) {
        claimedTicketIds.add(String(match.id));
        state.pending.delete(k);
        await finaliseConfirmed(attempt, match).catch((err) => {
          logger.error(
            "Velki.PlacementConfirmation",
            `finaliseConfirmed failed for ${k}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
        continue;
      }
      if (now >= attempt.deadlineAt) {
        const balanceCheck = await maybeExtendOnBalanceDelta(attempt).catch(
          (err) => {
            logger.warn(
              "Velki.PlacementConfirmation",
              `balance recheck failed for ${k}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
            return { extended: false, balanceDeducted: null } as const;
          },
        );
        if (balanceCheck.extended) continue;
        state.pending.delete(k);
        await finaliseTimedOut(attempt, balanceCheck.balanceDeducted).catch(
          (err) => {
            logger.error(
              "Velki.PlacementConfirmation",
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
  if (attempt.ticketIdHint) {
    for (const t of tickets) {
      if (claimed.has(String(t.id))) continue;
      if (String(t.id) === attempt.ticketIdHint) return t;
    }
  }

  // Feed amounts are already normalized to BDT by the reconciler, so
  // comparing t.initPrice against attempt.stake (also BDT) is correct.
  const stakeEq = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const submittedMs = attempt.submittedAt;

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

const ODDS_DRIFT_THRESHOLD = 0.02;

async function finaliseConfirmed(
  attempt: PendingConfirmation,
  ticket: GeniusSportsUnMatchTicket,
): Promise<void> {
  const ticketId = String(ticket.id);
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
      "Velki.PlacementConfirmation",
      `confirmed ${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
        `ticket=${ticketId} (${Math.round((Date.now() - attempt.submittedAt) / 1000)}s after submission)`,
    );
    if (driftAlert) {
      logger.warn(
        "Velki.PlacementConfirmation",
        `odds/stake drift detected on ticket ${ticketId}: ` +
          `requested ${driftAlert.requestedStake}@${driftAlert.requestedOdds} → ` +
          `booked ${driftAlert.actualStake}@${driftAlert.actualOdds} ` +
          `(Δodds=${driftAlert.oddsDrift.toFixed(3)}, Δstake=${driftAlert.stakeDrift.toFixed(2)})`,
      );
      await notify({
        type: "system",
        at: new Date().toISOString(),
        severity: "warn",
        message:
          `Odds drift on ${attempt.eventName} · ${attempt.marketType} → ` +
          `${attempt.atomLabel}: requested ${driftAlert.requestedOdds}, ` +
          `booked ${driftAlert.actualOdds} (Δ=${driftAlert.oddsDrift.toFixed(3)}). ` +
          `Ticket ${ticketId}. The DB row reflects the BOOKED value.`,
      }).catch(() => {});
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
      logger.error(
        "Velki.PlacementConfirmation",
        `confirm ${attempt.eventId}|${attempt.familyId}|${attempt.atomId}: ` +
          `reservation row missing when attaching ticket ${ticketId} — ` +
          `book accepted but no DB row to patch. Manual reconciliation required.`,
      );
      return;
    }
    logger.error(
      "Velki.PlacementConfirmation",
      `finaliseConfirmed insertPlacedBet failed for ` +
        `${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
        `(ticket ${ticketId}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    throw err;
  }
}

async function maybeExtendOnBalanceDelta(
  attempt: PendingConfirmation,
): Promise<{ extended: boolean; balanceDeducted: boolean | null }> {
  if (attempt.balanceAtSubmit === null) {
    return { extended: false, balanceDeducted: null };
  }
  if (attempt.extendedOnce) {
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
    "Velki.PlacementConfirmation",
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
    "Velki.PlacementConfirmation",
    `timeout ${attempt.eventId}|${attempt.familyId}|${attempt.atomId} ` +
      `after ${ageSec}s — no matching ticket in book feed; no DB write ` +
      `(balanceDeducted=${balanceDeducted})`,
  );
  const errorMsg =
    balanceDeducted === true
      ? `Book reserved the stake (balance dropped by ~${attempt.stake} ${attempt.currency}) ` +
        `but no ticket surfaced in the bet-history feed within ${ageSec}s. ` +
        `Money is almost certainly on a live ticket — reconcile manually in Velki.`
      : balanceDeducted === false
        ? `Book accepted the submission but balance was NOT deducted and no ticket ` +
          `appeared in the bet-history feed within ${ageSec}s. ` +
          `Bet was silently dropped (WAF / book-side reject). Not persisted.`
        : `Book accepted the submission but the bet never appeared in the provider's ` +
          `bet-history feed within ${ageSec}s. ` +
          `Not persisted to DB. Check Velki directly to confirm placement status.`;
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

export function listPendingConfirmations(): PendingConfirmation[] {
  return Array.from(getState().pending.values());
}

export const CONFIRMATION_PROVIDER = PROVIDER;
