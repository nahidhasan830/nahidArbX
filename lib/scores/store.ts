/**
 * Live Score Store
 *
 * In-memory store for caching live match scores.
 * Scores are keyed by Pinnacle event ID (provider-specific).
 */

import type { LiveScore, DisplayScore, CornersScore } from "./types";
import { toDisplayScore } from "./types";

// Store keyed by Pinnacle event ID (string)
const scoreStore = new Map<string, LiveScore>();
const cornersStore = new Map<string, CornersScore>();

/**
 * Update or insert a live score.
 *
 * Only updates if the version is newer (prevents stale WS messages from
 * clobbering fresher ones).
 *
 * Half-time snapshot: Pinnacle's WS has no explicit HT field — the
 * homeScore/awayScore are cumulative. We synthesise HT as
 * "the last score seen while state=1 (1st half)". The moment we
 * observe state=2 for the first time, the previous-tick state=1
 * score is HT; we persist it on the new entry and carry it forward
 * for every subsequent update so settlement can read it even long
 * after full-time.
 */
export function setLiveScore(pinnacleEventId: string, score: LiveScore): void {
  const existing = scoreStore.get(pinnacleEventId);

  // Only update if version is newer (prevents stale updates)
  if (existing && score.version <= existing.version) return;

  let htHome = score.htHome ?? existing?.htHome;
  let htAway = score.htAway ?? existing?.htAway;

  if (htHome === undefined || htAway === undefined) {
    const leavingFirstHalf =
      existing && existing.state === 1 && score.state >= 2;
    if (leavingFirstHalf) {
      // Transition detected — freeze the last state=1 score as HT.
      htHome = existing.homeScore;
      htAway = existing.awayScore;
    } else if (score.state >= 2 && existing === undefined) {
      // We tuned in late (already in 2H) and Pinnacle doesn't back-fill.
      // Leave HT undefined — another tier will have to resolve it.
    }
  }

  scoreStore.set(pinnacleEventId, {
    ...score,
    htHome,
    htAway,
  });
}

/**
 * Get live score by Pinnacle event ID
 */
export function getLiveScore(pinnacleEventId: string): LiveScore | undefined {
  return scoreStore.get(pinnacleEventId);
}

/**
 * Get display-formatted score by Pinnacle event ID
 */
export function getDisplayScore(
  pinnacleEventId: string,
): DisplayScore | undefined {
  const score = scoreStore.get(pinnacleEventId);
  return score ? toDisplayScore(score) : undefined;
}

/**
 * Get all live scores
 */
export function getAllLiveScores(): Map<string, LiveScore> {
  return new Map(scoreStore);
}

/**
 * Clear a specific score (when match ends or event removed)
 */
export function clearLiveScore(pinnacleEventId: string): void {
  scoreStore.delete(pinnacleEventId);
}

/**
 * Clear all scores
 */
export function clearAllScores(): void {
  scoreStore.clear();
}

/**
 * Get count of tracked scores
 */
export function getScoreCount(): number {
  return scoreStore.size;
}

// ============================================
// Corners Score Functions
// ============================================

/**
 * Update or insert a corners score
 * Only updates if the version is newer
 */
export function setCornersScore(
  pinnacleEventId: string,
  score: CornersScore,
): void {
  const existing = cornersStore.get(pinnacleEventId);

  // Only update if version is newer (prevents stale updates)
  if (!existing || score.version > existing.version) {
    cornersStore.set(pinnacleEventId, score);
  }
}

/**
 * Get corners score by Pinnacle event ID
 */
export function getCornersScore(
  pinnacleEventId: string,
): CornersScore | undefined {
  return cornersStore.get(pinnacleEventId);
}

/**
 * Clear a specific corners score
 */
export function clearCornersScore(pinnacleEventId: string): void {
  cornersStore.delete(pinnacleEventId);
}

/**
 * Get count of tracked corners scores
 */
export function getCornersScoreCount(): number {
  return cornersStore.size;
}

/**
 * Cleanup old scores (older than specified age in ms)
 * Useful for cleaning up scores from ended matches
 */
export function cleanupOldScores(
  maxAgeMs: number = 3 * 60 * 60 * 1000,
): number {
  const now = Date.now();
  let removed = 0;

  for (const [eventId, score] of scoreStore) {
    if (now - score.updatedAt > maxAgeMs) {
      scoreStore.delete(eventId);
      removed++;
    }
  }

  return removed;
}
