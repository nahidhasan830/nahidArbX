
import type { LiveScore, DisplayScore, CornersScore } from "./types";
import { toDisplayScore } from "./types";

const scoreStore = new Map<string, LiveScore>();
const cornersStore = new Map<string, CornersScore>();

export function setLiveScore(pinnacleEventId: string, score: LiveScore): void {
  const existing = scoreStore.get(pinnacleEventId);

  if (existing && score.version <= existing.version) return;

  let htHome = score.htHome ?? existing?.htHome;
  let htAway = score.htAway ?? existing?.htAway;

  if (htHome === undefined || htAway === undefined) {
    const leavingFirstHalf =
      existing && existing.state === 1 && score.state >= 2;
    if (leavingFirstHalf) {
      htHome = existing.homeScore;
      htAway = existing.awayScore;
    } else if (score.state >= 2 && existing === undefined) {
    }
  }

  scoreStore.set(pinnacleEventId, {
    ...score,
    htHome,
    htAway,
  });
}

export function getLiveScore(pinnacleEventId: string): LiveScore | undefined {
  return scoreStore.get(pinnacleEventId);
}

export function getDisplayScore(
  pinnacleEventId: string,
): DisplayScore | undefined {
  const score = scoreStore.get(pinnacleEventId);
  return score ? toDisplayScore(score) : undefined;
}

export function getAllLiveScores(): Map<string, LiveScore> {
  return new Map(scoreStore);
}

export function clearLiveScore(pinnacleEventId: string): void {
  scoreStore.delete(pinnacleEventId);
}

export function clearAllScores(): void {
  scoreStore.clear();
}

export function getScoreCount(): number {
  return scoreStore.size;
}


export function setCornersScore(
  pinnacleEventId: string,
  score: CornersScore,
): void {
  const existing = cornersStore.get(pinnacleEventId);

  if (!existing || score.version > existing.version) {
    cornersStore.set(pinnacleEventId, score);
  }
}

export function getCornersScore(
  pinnacleEventId: string,
): CornersScore | undefined {
  return cornersStore.get(pinnacleEventId);
}

export function clearCornersScore(pinnacleEventId: string): void {
  cornersStore.delete(pinnacleEventId);
}

export function getCornersScoreCount(): number {
  return cornersStore.size;
}

export function cleanupOldScores(
  maxAgeMs: number = 3 * 60 * 60 * 1000,
): number {
  const now = Date.now();
  let removed = 0;

  for (const [eventId, score] of scoreStore) {
    if (now - score.updatedAt > maxAgeMs) {
      scoreStore.delete(eventId);
      cornersStore.delete(eventId);
      removed++;
    }
  }

  for (const [eventId, cs] of cornersStore) {
    if (now - cs.updatedAt > maxAgeMs) {
      cornersStore.delete(eventId);
      removed++;
    }
  }

  return removed;
}
