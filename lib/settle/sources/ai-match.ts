/**
 * AI-assisted team matching for the settlement waterfall.
 *
 * When pure fuzzy matching produces a borderline score (below the accept
 * threshold but above a "maybe" floor), this module calls the AI Search
 * pipeline (HuggingFace + web grounding) to verify whether the candidate is the
 * same event. On a positive verdict, the alias is persisted to the entity
 * DB via `learnTeamAlias()` so future settlement runs resolve instantly.
 *
 * This is the bridge between the Matcher Lab's AI infrastructure and the
 * settlement pipeline — same underlying service, different trigger.
 *
 * Cost: free (HuggingFace free tier / Groq fallback). The AI Search service
 * must be running at `AI_SEARCH_URL` (default localhost:8090).
 */

import {
  matchSingle,
  checkHealth,
  type AiSearchEventInfo,
  type AiSearchMatchVerdict,
} from "../../matching/ai-search-client";
import { learnTeamAlias } from "../aliases";
import { logger } from "../../shared/logger";

const tag = "SettleAiMatch";

/** Minimum AI confidence (0–100) to accept a match. */
const AI_CONFIDENCE_THRESHOLD = 70;

/**
 * Fuzzy-score floor below which we don't even bother asking the AI.
 * If the combined team similarity is below this, the teams are too
 * different for AI to plausibly confirm.
 */
export const AI_MAYBE_FLOOR = 0.40;

/**
 * Fuzzy-score ceiling — above this we accept without AI. This is the
 * normal acceptance threshold used by ESPN/API-Football sources.
 */
export const AI_MAYBE_CEILING = 0.65;

export interface AiMatchCandidate {
  /** Our event's details. */
  ourHomeTeam: string;
  ourAwayTeam: string;
  ourCompetition: string | null;
  ourStartTime: string; // ISO

  /** Score source's event details. */
  theirHomeTeam: string;
  theirAwayTeam: string;
  theirCompetition?: string;
  theirStartTime?: string; // ISO

  /** The fuzzy similarity score that triggered the AI check. */
  fuzzySimilarity: number;

  /** Source provider name for alias learning. */
  sourceProvider: string;
}

export interface AiMatchResult {
  /** Whether the AI confirmed the match. */
  confirmed: boolean;
  /** AI's decision. */
  decision: "SAME" | "DIFFERENT" | "UNCERTAIN";
  /** AI's confidence (0–100). */
  confidence: number;
  /** AI's reasoning (for logging). */
  reasoning: string;
}

let _healthChecked = false;
let _isHealthy = false;

/**
 * Check if the AI Search service is available. Cached for the process
 * lifetime to avoid repeated health checks during a single batch.
 */
async function isAiAvailable(): Promise<boolean> {
  if (_healthChecked) return _isHealthy;
  try {
    const health = await checkHealth();
    _isHealthy = health?.ok === true;
  } catch {
    _isHealthy = false;
  }
  _healthChecked = true;
  // Reset after 5 minutes so we re-check on the next batch
  setTimeout(() => {
    _healthChecked = false;
  }, 5 * 60 * 1000);
  return _isHealthy;
}

/**
 * Ask the AI Search pipeline to verify a borderline team match.
 *
 * On a positive verdict (SAME + confidence ≥ threshold), persists the
 * team name alias to the entity DB so future settlement runs skip AI
 * entirely.
 *
 * Returns null if the AI service is unavailable (graceful degradation).
 */
export async function verifySettlementMatch(
  candidate: AiMatchCandidate,
): Promise<AiMatchResult | null> {
  if (!(await isAiAvailable())) return null;

  const eventA: AiSearchEventInfo = {
    home_team: candidate.ourHomeTeam,
    away_team: candidate.ourAwayTeam,
    competition: candidate.ourCompetition ?? "",
    start_time: candidate.ourStartTime,
    provider: "settle",
  };

  const eventB: AiSearchEventInfo = {
    home_team: candidate.theirHomeTeam,
    away_team: candidate.theirAwayTeam,
    competition: candidate.theirCompetition ?? "",
    start_time: candidate.theirStartTime ?? candidate.ourStartTime,
    provider: candidate.sourceProvider,
  };

  let verdict: AiSearchMatchVerdict | null;
  try {
    verdict = await matchSingle(eventA, eventB);
  } catch (err) {
    logger.warn(tag, `AI verify failed: ${(err as Error).message}`);
    return null;
  }
  if (!verdict) return null;

  const confirmed =
    verdict.decision === "SAME" &&
    verdict.confidence >= AI_CONFIDENCE_THRESHOLD;

  const label = `${candidate.ourHomeTeam} v ${candidate.ourAwayTeam} ↔ ${candidate.theirHomeTeam} v ${candidate.theirAwayTeam}`;

  if (confirmed) {
    logger.info(
      tag,
      `AI confirmed match (${verdict.confidence}%): ${label} — persisting aliases.`,
    );

    // Persist team name aliases to the entity DB.
    // This is the one-time cost: future settlement runs will resolve
    // these team names via the pre-resolve cache without AI.
    try {
      await learnTeamAlias(candidate.ourHomeTeam, candidate.theirHomeTeam, {
        provider: candidate.sourceProvider,
        competition: candidate.ourCompetition,
      });
      await learnTeamAlias(candidate.ourAwayTeam, candidate.theirAwayTeam, {
        provider: candidate.sourceProvider,
        competition: candidate.ourCompetition,
      });
    } catch (err) {
      logger.warn(
        tag,
        `Alias persistence failed (non-fatal): ${(err as Error).message}`,
      );
    }
  } else {
    logger.debug(
      tag,
      `AI ${verdict.decision} (${verdict.confidence}%): ${label}`,
    );
  }

  return {
    confirmed,
    decision: verdict.decision,
    confidence: verdict.confidence,
    reasoning: verdict.reasoning,
  };
}
