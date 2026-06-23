
import type { ValueBet } from "../atoms/value-detector";
import { getValueBets } from "../store";
import { logger } from "../shared/logger";
import { singleton } from "@/lib/util/singleton";


export interface DashboardDelta {
  type: "delta";
  version: number;
  timestamp: number;

  valueBetsAdded: ValueBet[];
  valueBetsRemoved: string[];

  summary: {
    totalValueBets: number;
    bestEvPct: number | null;
  };

  changeCount: number;
}

export interface FullRefreshSignal {
  type: "full-refresh";
  version: number;
  reason: string;
}

export type DeltaOrRefresh = DashboardDelta | FullRefreshSignal;


interface Snapshot {
  version: number;
  valueBetKeys: Set<string>;
  valueBetMap: Map<string, ValueBet>;
}

const MAX_DELTA_CHANGES = 200;

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

  deltaState.lastSnapshot = current;

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

export function signalFixturesChanged(version: number): FullRefreshSignal {
  deltaState.lastSnapshot = null;
  return {
    type: "full-refresh",
    version,
    reason: "fixtures-changed",
  };
}

export function resetDeltaTracking(): void {
  deltaState.lastSnapshot = null;
}

export function getDeltaStats() {
  return {
    hasSnapshot: deltaState.lastSnapshot !== null,
    snapshotVersion: deltaState.lastSnapshot?.version ?? null,
    snapshotValueBets: deltaState.lastSnapshot?.valueBetKeys.size ?? 0,
  };
}
