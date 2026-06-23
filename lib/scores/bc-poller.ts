
import { fetchGameMarkets } from "../adapters/betconstruct/client";
import { setSourceScore, getNormalizedId } from "./multi-source-store";
import { bcStateToPeriod, type SourceScore } from "./types";
import { singleton } from "../util/singleton";


const POLL_INTERVAL_MS = 10_000;


const s = singleton("scores:bc-poller", () => ({
  timer: null as NodeJS.Timeout | null,
  activeEventIds: new Set<string>(),
}));


export function startBCScorePolling(bcEventIds: string[]): void {
  s.activeEventIds = new Set(bcEventIds);

  if (s.activeEventIds.size === 0) {
    stopBCScorePolling();
    return;
  }

  if (!s.timer) {
    s.timer = setInterval(pollAllEvents, POLL_INTERVAL_MS);

    pollAllEvents();
  }
}

export function stopBCScorePolling(): void {
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  s.activeEventIds.clear();
}

export function addBCEventsToPolling(bcEventIds: string[]): void {
  for (const id of bcEventIds) {
    s.activeEventIds.add(id);
  }

  if (s.activeEventIds.size > 0 && !s.timer) {
    startBCScorePolling(Array.from(s.activeEventIds));
  }
}

export function removeBCEventsFromPolling(bcEventIds: string[]): void {
  for (const id of bcEventIds) {
    s.activeEventIds.delete(id);
  }

  if (s.activeEventIds.size === 0) {
    stopBCScorePolling();
  }
}

export function isBCPollingActive(): boolean {
  return s.timer !== null;
}

export function getBCPollingCount(): number {
  return s.activeEventIds.size;
}


async function pollAllEvents(): Promise<void> {
  const eventIds = Array.from(s.activeEventIds);
  if (eventIds.length === 0) return;

  const CONCURRENCY = 5;
  const results: Promise<void>[] = [];

  for (let i = 0; i < eventIds.length; i += CONCURRENCY) {
    const batch = eventIds.slice(i, i + CONCURRENCY);
    results.push(Promise.all(batch.map(pollSingleEvent)).then(() => undefined));
  }

  await Promise.all(results);
}

async function pollSingleEvent(bcEventId: string): Promise<void> {
  try {
    const game = await fetchGameMarkets(parseInt(bcEventId, 10));

    if (!game) {
      return;
    }

    if (game.type !== 1 || !game.info) {
      return;
    }

    const normalizedId = getNormalizedId("betconstruct", bcEventId);
    if (!normalizedId) {
      return;
    }

    const score: SourceScore = {
      source: "betconstruct",
      homeScore: parseInt(game.info.score1 || "0", 10),
      awayScore: parseInt(game.info.score2 || "0", 10),
      minute: parseInt(game.info.current_game_time || "0", 10),
      period: bcStateToPeriod(game.info.current_game_state),
      updatedAt: Date.now(),
    };

    setSourceScore(normalizedId, score);
  } catch {
  }
}

export async function pollBCScoresNow(bcEventIds: string[]): Promise<number> {
  let updated = 0;

  for (const bcEventId of bcEventIds) {
    try {
      await pollSingleEvent(bcEventId);
      updated++;
    } catch {
    }
  }

  return updated;
}
