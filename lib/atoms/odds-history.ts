/**
 * Odds Movement History
 *
 * In-memory ring buffer that records every price tick per atom/provider.
 * Used for:
 *   - Sparkline data on the dashboard
 *   - Opening / peak / trough tracking
 *   - Steam move detection (sharp sudden line movements)
 *   - DB-ready snapshot export (persisted alongside value bets)
 *
 * Memory budget: ~8 MB for typical workload (200 ticks × 50 atoms × 20 events × 4 providers).
 * Auto-pruned when events leave the active roster.
 */

import { singleton } from "@/lib/util/singleton";
import {
  ODDS_HISTORY_MAX_TICKS,
  STEAM_MOVE_WINDOW_MS,
  STEAM_MOVE_MODERATE_PCT,
  STEAM_MOVE_STRONG_PCT,
} from "@/lib/shared/constants";
import type { NormalizedOddsEntry } from "./types";
import type { OddsMovementData } from "@/lib/bets-history/types";

// ============================================
// Types
// ============================================

export interface OddsTick {
  odds: number;
  timestamp: number; // Unix ms
  suspended: boolean;
}

export interface AtomHistory {
  /** Circular buffer of recent ticks (newest at the end). */
  ticks: OddsTick[];
  /** Write cursor into the ring buffer (wraps at maxTicks). */
  cursor: number;
  /** Total ticks recorded (may exceed maxTicks). */
  totalTicks: number;
  /** First non-suspended odds seen for this atom/provider. */
  openingOdds: number | null;
  openingTimestamp: number | null;
  /** Highest non-suspended odds seen. */
  peakOdds: number;
  /** Lowest non-suspended odds seen. */
  troughOdds: number;
}

export interface SteamMoveSignal {
  direction: "up" | "down";
  magnitudePct: number;
  durationMs: number;
  tickCount: number;
  startOdds: number;
  endOdds: number;
  significance: "weak" | "moderate" | "strong";
}

/** @deprecated Use `OddsMovementData` from `@/lib/bets-history/types` directly. */
export type OddsMovementSnapshot = OddsMovementData;

// ============================================
// Storage — singleton for HMR safety
// ============================================

// Key format: `${eventId}|${familyId}|${atomId}|${provider}`
type HistoryStore = Map<string, AtomHistory>;

const store = singleton(
  "atoms:oddsHistory",
  (): HistoryStore => new Map(),
);

const maxTicks = ODDS_HISTORY_MAX_TICKS;

function makeKey(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): string {
  return `${eventId}|${familyId}|${atomId}|${provider}`;
}

// ============================================
// Write
// ============================================

/**
 * Record a single odds tick into the ring buffer.
 * Called from `setOdds()` in `store.ts` on every write.
 */
export function recordOddsTick(entry: NormalizedOddsEntry): void {
  const key = makeKey(
    entry.event_id,
    entry.family_id,
    entry.atom_id,
    entry.provider,
  );

  let hist = store.get(key);
  if (!hist) {
    hist = {
      ticks: new Array<OddsTick>(maxTicks),
      cursor: 0,
      totalTicks: 0,
      openingOdds: null,
      openingTimestamp: null,
      peakOdds: -Infinity,
      troughOdds: Infinity,
    };
    store.set(key, hist);
  }

  const tick: OddsTick = {
    odds: entry.odds,
    timestamp: entry.timestamp,
    suspended: entry.suspended ?? false,
  };

  // Write into ring buffer at cursor position
  hist.ticks[hist.cursor] = tick;
  hist.cursor = (hist.cursor + 1) % maxTicks;
  hist.totalTicks++;

  // Track opening odds (first non-suspended)
  if (!tick.suspended) {
    if (hist.openingOdds === null) {
      hist.openingOdds = tick.odds;
      hist.openingTimestamp = tick.timestamp;
    }
    if (tick.odds > hist.peakOdds) hist.peakOdds = tick.odds;
    if (tick.odds < hist.troughOdds) hist.troughOdds = tick.odds;
  }
}

// ============================================
// Read
// ============================================

/** Get raw history for a single atom/provider. */
export function getAtomHistory(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): AtomHistory | null {
  return store.get(makeKey(eventId, familyId, atomId, provider)) ?? null;
}

/**
 * Get ordered ticks (oldest → newest) for an atom/provider.
 * The ring buffer stores them in write order; this unrolls them chronologically.
 */
export function getOrderedTicks(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): OddsTick[] {
  const hist = store.get(makeKey(eventId, familyId, atomId, provider));
  if (!hist) return [];

  const filled = Math.min(hist.totalTicks, maxTicks);
  const result: OddsTick[] = [];

  // Read from oldest to newest
  const start = hist.totalTicks >= maxTicks ? hist.cursor : 0;
  for (let i = 0; i < filled; i++) {
    const idx = (start + i) % maxTicks;
    const tick = hist.ticks[idx];
    if (tick) result.push(tick);
  }

  return result;
}

/**
 * Get sparkline-ready data: [{t, o}] for the last N minutes.
 * Defaults to full history if no time window specified.
 */
export function getSparklineData(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
  lastNMinutes?: number,
): { t: number; o: number }[] {
  const ticks = getOrderedTicks(eventId, familyId, atomId, provider);
  if (ticks.length === 0) return [];

  const cutoff = lastNMinutes
    ? Date.now() - lastNMinutes * 60_000
    : 0;

  return ticks
    .filter((t) => !t.suspended && t.timestamp >= cutoff)
    .map((t) => ({ t: t.timestamp, o: t.odds }));
}

/**
 * Build a compact snapshot for DB persistence.
 * Attached to value bets so historical movement is preserved permanently.
 */
export function buildMovementSnapshot(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): OddsMovementData | null {
  const hist = store.get(makeKey(eventId, familyId, atomId, provider));
  if (!hist || hist.totalTicks === 0) return null;

  const ticks = getOrderedTicks(eventId, familyId, atomId, provider);
  // Compact sparkline: last 50 non-suspended ticks as [timestamp, odds]
  const sparkline: [number, number][] = ticks
    .filter((t) => !t.suspended)
    .slice(-50)
    .map((t) => [t.timestamp, t.odds]);

  return {
    provider,
    openingOdds: hist.openingOdds,
    peakOdds: hist.peakOdds === -Infinity ? 0 : hist.peakOdds,
    troughOdds: hist.troughOdds === Infinity ? 0 : hist.troughOdds,
    totalTicks: hist.totalTicks,
    sparkline,
  };
}

// ============================================
// Movement Summary (for live API responses)
// ============================================

/** Lightweight movement summary for live frontend display. */
export interface OddsMovementSummary {
  direction: "up" | "down" | "stable";
  /** % change from the previous tick to the latest tick. */
  changePct: number;
  openingOdds: number | null;
  peakOdds: number;
  troughOdds: number;
  totalTicks: number;
  /** Last 20 non-suspended ticks as [timestamp, odds] tuples for inline sparklines. */
  sparkline: [number, number][];
  steamMove: SteamMoveSignal | null;
}

/**
 * Build a lightweight movement summary for a single atom/provider.
 * Designed for the live API response — cheap to compute, small payload.
 */
export function getMovementSummary(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): OddsMovementSummary | null {
  const hist = store.get(makeKey(eventId, familyId, atomId, provider));
  if (!hist || hist.totalTicks === 0) return null;

  const ticks = getOrderedTicks(eventId, familyId, atomId, provider);
  const nonSuspended = ticks.filter((t) => !t.suspended);

  if (nonSuspended.length === 0) return null;

  // changePct: opening-to-current (not last-two-ticks).
  // This matches the ML feature catalog description and is stable
  // against single-tick data glitches.
  let changePct = 0;
  const latestTick = nonSuspended[nonSuspended.length - 1];
  if (hist.openingOdds != null && hist.openingOdds > 0) {
    changePct =
      Math.round(((latestTick.odds - hist.openingOdds) / hist.openingOdds) * 10000) / 100;
    // Clamp to ±50% — anything beyond is a data feed glitch
    changePct = Math.max(-50, Math.min(50, changePct));
  }

  // Direction: windowed over the last 10 non-suspended ticks to capture
  // recent trend without being vulnerable to single-tick noise.
  let direction: "up" | "down" | "stable" = "stable";
  const dirWindow = nonSuspended.slice(-10);
  if (dirWindow.length >= 2) {
    const wFirst = dirWindow[0];
    const wLast = dirWindow[dirWindow.length - 1];
    if (wFirst.odds > 0) {
      const wChangePct = ((wLast.odds - wFirst.odds) / wFirst.odds) * 100;
      if (wChangePct > 0.1) direction = "up";
      else if (wChangePct < -0.1) direction = "down";
    }
  }

  // Compact sparkline: last 20 non-suspended ticks
  const sparkline: [number, number][] = nonSuspended
    .slice(-20)
    .map((t) => [t.timestamp, t.odds]);

  // Steam move detection (reuse existing logic)
  const steamMove = detectSteamMove(eventId, familyId, atomId, provider);

  return {
    direction,
    changePct,
    openingOdds: hist.openingOdds,
    peakOdds: hist.peakOdds === -Infinity ? 0 : hist.peakOdds,
    troughOdds: hist.troughOdds === Infinity ? 0 : hist.troughOdds,
    totalTicks: hist.totalTicks,
    sparkline,
    steamMove,
  };
}

// ============================================
// Steam Move Detection
// ============================================

/**
 * Detect a steam move (sharp sudden line movement) for a given atom/provider.
 * Looks at the last STEAM_MOVE_WINDOW_MS (60s) of ticks.
 */
export function detectSteamMove(
  eventId: string,
  familyId: string,
  atomId: string,
  provider: string,
): SteamMoveSignal | null {
  const ticks = getOrderedTicks(eventId, familyId, atomId, provider);
  if (ticks.length < 3) return null;

  const now = Date.now();
  const cutoff = now - STEAM_MOVE_WINDOW_MS;

  // Filter to recent non-suspended ticks
  const recent = ticks.filter((t) => !t.suspended && t.timestamp >= cutoff);
  if (recent.length < 2) return null;

  const first = recent[0];
  const last = recent[recent.length - 1];
  const changePct = Math.abs((last.odds - first.odds) / first.odds) * 100;
  const durationMs = last.timestamp - first.timestamp;

  if (changePct < 1) return null; // Not significant

  const direction: "up" | "down" = last.odds > first.odds ? "up" : "down";

  let significance: "weak" | "moderate" | "strong";
  if (changePct >= STEAM_MOVE_STRONG_PCT && durationMs <= 30_000) {
    significance = "strong";
  } else if (changePct >= STEAM_MOVE_MODERATE_PCT) {
    significance = "moderate";
  } else {
    significance = "weak";
  }

  // Only report moderate+ moves
  if (significance === "weak") return null;

  return {
    direction,
    magnitudePct: Math.round(changePct * 100) / 100,
    durationMs,
    tickCount: recent.length,
    startOdds: first.odds,
    endOdds: last.odds,
    significance,
  };
}

// ============================================
// Cleanup
// ============================================

/** Prune all history for events no longer in the active roster. */
export function pruneHistoryForEvents(activeEventIds: Set<string>): number {
  let pruned = 0;
  for (const key of store.keys()) {
    const eventId = key.substring(0, key.indexOf("|"));
    if (!activeEventIds.has(eventId)) {
      store.delete(key);
      pruned++;
    }
  }
  return pruned;
}

/** Prune all history for a single event. */
export function pruneHistoryForEvent(eventId: string): void {
  const prefix = `${eventId}|`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

/** Get total number of tracked atom/provider entries (diagnostic). */
export function getHistoryStats(): {
  trackedAtoms: number;
  totalTicksRecorded: number;
  memoryEstimateBytes: number;
} {
  let totalTicks = 0;
  for (const hist of store.values()) {
    totalTicks += Math.min(hist.totalTicks, maxTicks);
  }
  return {
    trackedAtoms: store.size,
    totalTicksRecorded: totalTicks,
    // ~40 bytes per tick (odds: 8, timestamp: 8, suspended: 1, overhead: ~23)
    memoryEstimateBytes: totalTicks * 40 + store.size * 100,
  };
}
