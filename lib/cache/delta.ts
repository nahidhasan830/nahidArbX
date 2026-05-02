/**
 * Delta Computation for SSE Push Updates
 *
 * Instead of the client fetching the full 500KB-2MB dashboard payload
 * every time data changes, the server computes a compact diff and pushes
 * it via SSE. The client applies the diff to its local state.
 *
 * Delta types:
 * - valueBetsAdded/valueBetsRemoved: Value bet changes
 * - oddsChanged: Per-event odds updates
 * - summaryUpdate: Updated summary stats
 *
 * Full refresh triggers:
 * - Client reconnect (no previous snapshot)
 * - Delta too large (>200 changes = cheaper to full refresh)
 * - Fixtures changed (event list changed)
 */

import type { ValueBet } from "../atoms/value-detector";
import { getValueBets } from "../store";
import { logger } from "../shared/logger";
import { singleton } from "@/lib/util/singleton";

// ============================================
// Types
// ============================================

export interface DashboardDelta {
  type: "delta";
  version: number;
  timestamp: number;

  // Value bet changes
  valueBetsAdded: ValueBet[];
  valueBetsRemoved: string[]; // atom keys

  // Summary update
  summary: {
    totalValueBets: number;
    bestEvPct: number | null;
  };

  // Change count (for client to decide if delta or full refresh)
  changeCount: number;
}

export interface FullRefreshSignal {
  type: "full-refresh";
  version: number;
  reason: string;
}

export type DeltaOrRefresh = DashboardDelta | FullRefreshSignal;

// ============================================
// Snapshot Tracking
// ============================================

interface Snapshot {
  version: number;
  valueBetKeys: Set<string>;
  valueBetMap: Map<string, ValueBet>;
}

const MAX_DELTA_CHANGES = 200; // Beyond this, signal full refresh

// Singleton for HMR safety — both module graphs share one snapshot.
const deltaState = singleton("delta:state", () => ({
  lastSnapshot: null as Snapshot | null,
}));

function getValueBetKey(vb: ValueBet): string {
  return `${vb.eventId}:${vb.atomId}`;
}

function takeSnapshot(version: number): Snapshot {
  const valueBets = getValueBets();
  const valueBetMap = new Map<string, ValueBet>();

  for (const vb of valueBets) {
    valueBetMap.set(getValueBetKey(vb), vb);
  }

  return {
    version,
    valueBetKeys: new Set(valueBetMap.keys()),
    valueBetMap,
  };
}

// ============================================
// Delta Computation
// ============================================

/**
 * Compute delta between current state and last snapshot.
 * Returns a DashboardDelta if changes are small enough,
 * or a FullRefreshSignal if delta is too large.
 */
export function computeDelta(currentVersion: number): DeltaOrRefresh {
  const current = takeSnapshot(currentVersion);

  if (!deltaState.lastSnapshot) {
    deltaState.lastSnapshot = current;
    return {
      type: "full-refresh",
      version: currentVersion,
      reason: "no-previous-snapshot",
    };
  }

  const prev = deltaState.lastSnapshot;

  // Compute value bet changes
  const valueBetsAdded: ValueBet[] = [];
  const valueBetsRemoved: string[] = [];

  for (const key of current.valueBetKeys) {
    if (!prev.valueBetKeys.has(key)) {
      valueBetsAdded.push(current.valueBetMap.get(key)!);
    } else {
      const prevVb = prev.valueBetMap.get(key)!;
      const currVb = current.valueBetMap.get(key)!;
      if (Math.abs(prevVb.evPct - currVb.evPct) > 0.1) {
        valueBetsAdded.push(currVb);
      }
    }
  }

  for (const key of prev.valueBetKeys) {
    if (!current.valueBetKeys.has(key)) {
      valueBetsRemoved.push(key);
    }
  }

  const changeCount = valueBetsAdded.length + valueBetsRemoved.length;

  // Update snapshot
  deltaState.lastSnapshot = current;

  // If too many changes, signal full refresh
  if (changeCount > MAX_DELTA_CHANGES) {
    logger.debug(
      "Delta",
      `Too many changes (${changeCount}), signaling full refresh`,
    );
    return {
      type: "full-refresh",
      version: currentVersion,
      reason: `delta-too-large:${changeCount}`,
    };
  }

  // Build summary
  const valueBets = Array.from(current.valueBetMap.values());

  return {
    type: "delta",
    version: currentVersion,
    timestamp: Date.now(),
    valueBetsAdded,
    valueBetsRemoved,
    summary: {
      totalValueBets: valueBets.length,
      bestEvPct:
        valueBets.length > 0
          ? Math.max(...valueBets.map((v) => v.evPct))
          : null,
    },
    changeCount,
  };
}

/**
 * Signal that fixtures changed — always requires full refresh.
 */
export function signalFixturesChanged(version: number): FullRefreshSignal {
  deltaState.lastSnapshot = null; // Reset snapshot on fixture change
  return {
    type: "full-refresh",
    version,
    reason: "fixtures-changed",
  };
}

/**
 * Reset delta tracking (e.g., on server restart).
 */
export function resetDeltaTracking(): void {
  deltaState.lastSnapshot = null;
}

/**
 * Get delta tracking stats for diagnostics.
 */
export function getDeltaStats() {
  return {
    hasSnapshot: deltaState.lastSnapshot !== null,
    snapshotVersion: deltaState.lastSnapshot?.version ?? null,
    snapshotValueBets: deltaState.lastSnapshot?.valueBetKeys.size ?? 0,
  };
}
