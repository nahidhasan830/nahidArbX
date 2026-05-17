/**
 * Tier 2d — AI Search score lookup (DeepSeek Flash + web search grounding).
 *
 * Covers the long tail of niche leagues that ESPN, API-Football, and
 * SofaScore all miss (e.g. Brazil Serie C, Paraguayan Clausura,
 * regional cups, youth tournaments).
 *
 * How it works:
 *   1. For each unresolved event, ask the AI Search service:
 *      "What was the final score of {home} vs {away} on {date}?"
 *   2. The Python service searches FlashScore, Google Sports, news sites
 *      using Vertex AI Search first and Brave second, then feeds the evidence
 *      to DeepSeek Flash, which extracts a structured answer.
 *   3. We parse the answer for a score pattern (e.g. "2-1", "3-0") and
 *      build a MatchScore if confidence >= 70%.
 *
 * Cost: DeepSeek API + configured search provider quota.
 * Latency: ~3-8s per event (search + LLM round-trip).
 *
 * This tier is the final catch-all in the waterfall, sitting after
 * SofaScore (Tier 2c). It resolves the long tail of niche leagues
 * that structured APIs miss but that exist on the open web.
 */

import type { SettleEvent } from "../waterfall";
import type { MatchScore } from "../types";
import { verifySettlement } from "@/lib/matching/ai-search-client";
import { logger } from "../../shared/logger";
import { saveScoreIfAbsent } from "../../db/repositories/match-scores";

const tag = "T2d-AiSearch";

// Only accept answers with confidence >= 70%
const MIN_CONFIDENCE = 70;

/**
 * Parse a score string like "2-1", "3 - 0", "1:2" into [home, away].
 * Returns null if no valid score pattern is found.
 */
function parseScore(answer: string): { home: number; away: number } | null {
  if (answer.trim().toUpperCase().startsWith("UNKNOWN")) return null;

  // Try common score formats: "2-1", "2 - 1", "2:1", "2 x 1"
  const patterns = [
    /(\d+)\s*[-–—:]\s*(\d+)/,       // "2-1", "2 : 1"
    /(\d+)\s*x\s*(\d+)/i,           // "2 x 1" (Brazilian style)
    /(\d+)\s+to\s+(\d+)/i,          // "2 to 1"
  ];

  for (const pat of patterns) {
    const m = answer.match(pat);
    if (m) {
      const home = parseInt(m[1], 10);
      const away = parseInt(m[2], 10);
      if (!isNaN(home) && !isNaN(away) && home >= 0 && away >= 0 && home <= 20 && away <= 20) {
        return { home, away };
      }
    }
  }
  return null;
}

/**
 * Try to extract HT score from the answer text.
 * Looks for patterns like "half-time: 1-0", "HT 1-0", "(1-0 at half time)"
 */
function parseHtScore(answer: string): { htHome: number; htAway: number } | null {
  const htPatterns = [
    /(?:half[\s-]*time|HT|1st\s*half)[\s:]*(\d+)\s*[-–—:]\s*(\d+)/i,
    /\((\d+)\s*[-–—:]\s*(\d+)\s*(?:at\s*)?(?:half[\s-]*time|HT)\)/i,
  ];

  for (const pat of htPatterns) {
    const m = answer.match(pat);
    if (m) {
      const htHome = parseInt(m[1], 10);
      const htAway = parseInt(m[2], 10);
      if (!isNaN(htHome) && !isNaN(htAway) && htHome >= 0 && htAway >= 0) {
        return { htHome, htAway };
      }
    }
  }
  return null;
}

/**
 * Fetch final scores for unresolved events using DeepSeek Flash + web search.
 *
 * For each event, calls /verify-settlement on the AI Search service
 * with a focused question about the final score. If the answer
 * contains a parseable score with high confidence, returns a MatchScore.
 *
 * Events are processed sequentially to respect LLM rate limits.
 */
export async function fetchAiSearchScores(
  events: SettleEvent[],
): Promise<Map<string, MatchScore>> {
  const results = new Map<string, MatchScore>();
  if (events.length === 0) return results;

  logger.info(tag, `Attempting AI Search score lookup for ${events.length} event(s).`);

  // Process sequentially — LLM providers have rate limits, and each call
  // involves web search + LLM inference (~5s). Parallelism would
  // overwhelm the rate limit on large batches.
  for (const event of events) {
    try {
      const dateStr = event.startTime.slice(0, 10);
      const question =
        `What was the final score of the football match ${event.homeTeam} vs ${event.awayTeam}` +
        (event.competition ? ` in ${event.competition}` : "") +
        ` on ${dateStr}? Please give the exact final score (e.g. "2-1") and half-time score if available.`;

      const verdict = await verifySettlement(
        {
          home_team: event.homeTeam,
          away_team: event.awayTeam,
          competition: event.competition ?? "",
          start_time: event.startTime,
        },
        question,
      );

      if (!verdict) {
        logger.debug(tag, `${event.homeTeam} v ${event.awayTeam}: AI Search unreachable`);
        continue;
      }

      if (verdict.confidence < MIN_CONFIDENCE) {
        logger.debug(
          tag,
          `${event.homeTeam} v ${event.awayTeam}: low confidence ${verdict.confidence}% — "${verdict.answer}"`,
        );
        continue;
      }

      let score = parseScore(verdict.answer);
      if (!score) {
        // Also try reasoning field — sometimes the score is there
        score = parseScore(verdict.reasoning);
        if (!score) {
          logger.debug(
            tag,
            `${event.homeTeam} v ${event.awayTeam}: no parseable score in "${verdict.answer}"`,
          );
          continue;
        }
      }

      const ht = parseHtScore(verdict.answer) ?? parseHtScore(verdict.reasoning);

      const matchScore: MatchScore = {
        eventId: event.eventId,
        status: "FT",
        ftHome: score.home,
        ftAway: score.away,
        htHome: ht?.htHome ?? null,
        htAway: ht?.htAway ?? null,
        cornersHome: null,
        cornersAway: null,
        htCornersHome: null,
        htCornersAway: null,
        bookingsHome: null,
        bookingsAway: null,
        source: "ai-search-deepseek",
        confidence: Math.min(verdict.confidence / 100, 0.95), // cap at 0.95
        fetchedAt: new Date().toISOString(),
      };

      results.set(event.eventId, matchScore);
      logger.info(
        tag,
        `✅ ${event.homeTeam} v ${event.awayTeam}: ${score.home}-${score.away} ` +
          `(${verdict.confidence}%, ${verdict.sources.length} web sources)`,
      );

      // Persist to cache so this event doesn't need another lookup
      try {
        await saveScoreIfAbsent(matchScore);
      } catch (err) {
        logger.warn(tag, `Cache persist failed for ${event.eventId}: ${(err as Error).message}`);
      }
    } catch (err) {
      logger.warn(
        tag,
        `${event.homeTeam} v ${event.awayTeam} failed: ${(err as Error).message}`,
      );
    }
  }

  logger.info(tag, `AI Search resolved ${results.size}/${events.length} events.`);
  return results;
}
