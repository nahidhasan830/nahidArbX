
import { inArray } from "drizzle-orm";
import { db } from "../client";
import { matchScores, type MatchScoreRow } from "../schema";
import type { MatchScore } from "../../settle/types";
import { logger } from "../../shared/logger";
import { maybeLogDispute } from "./settlement-disputes";

const toDomain = (row: MatchScoreRow): MatchScore => ({
  eventId: row.eventId,
  status: row.status as MatchScore["status"],
  htHome: row.htHome,
  htAway: row.htAway,
  ftHome: row.ftHome,
  ftAway: row.ftAway,
  etHome: row.etHome ?? null,
  etAway: row.etAway ?? null,
  penHome: row.penHome ?? null,
  penAway: row.penAway ?? null,
  cornersHome: row.cornersHome ?? null,
  cornersAway: row.cornersAway ?? null,
  htCornersHome: row.htCornersHome ?? null,
  htCornersAway: row.htCornersAway ?? null,
  bookingsHome: row.bookingsHome ?? null,
  bookingsAway: row.bookingsAway ?? null,
  source: row.source as MatchScore["source"],
  confidence: Number(row.confidence),
  sourceUrl: row.sourceUrl ?? null,
  fetchedAt: row.fetchedAt,
});

export const getScoresByEventIds = async (
  eventIds: string[],
): Promise<Map<string, MatchScore>> => {
  const out = new Map<string, MatchScore>();
  if (eventIds.length === 0) return out;
  const rows = await db
    .select()
    .from(matchScores)
    .where(inArray(matchScores.eventId, eventIds));
  for (const r of rows) out.set(r.eventId, toDomain(r));
  return out;
};

export const getScoreByEventId = async (
  eventId: string,
): Promise<MatchScore | null> => {
  const rows = await db
    .select()
    .from(matchScores)
    .where(inArray(matchScores.eventId, [eventId]))
    .limit(1);
  return rows[0] ? toDomain(rows[0]) : null;
};

export const saveScoreIfAbsent = async (
  score: MatchScore,
): Promise<"inserted" | "kept" | "disputed"> => {
  try {
    const rows = await db
      .insert(matchScores)
      .values({
        eventId: score.eventId,
        status: score.status,
        htHome: score.htHome,
        htAway: score.htAway,
        ftHome: score.ftHome,
        ftAway: score.ftAway,
        etHome: score.etHome ?? null,
        etAway: score.etAway ?? null,
        penHome: score.penHome ?? null,
        penAway: score.penAway ?? null,
        cornersHome: score.cornersHome ?? null,
        cornersAway: score.cornersAway ?? null,
        htCornersHome: score.htCornersHome ?? null,
        htCornersAway: score.htCornersAway ?? null,
        bookingsHome: score.bookingsHome ?? null,
        bookingsAway: score.bookingsAway ?? null,
        source: score.source,
        confidence: score.confidence,
        sourceUrl: score.sourceUrl ?? null,
      })
      .onConflictDoNothing({ target: matchScores.eventId })
      .returning({ eventId: matchScores.eventId });
    if (rows.length > 0) return "inserted";

    try {
      const cached = await getScoreByEventId(score.eventId);
      if (cached) {
        const disputed = await maybeLogDispute(cached, score);
        if (disputed) {
          logger.warn(
            "MatchScores",
            `Dispute logged for ${score.eventId}: cached ` +
              `${cached.ftHome}-${cached.ftAway} (${cached.source}) vs ` +
              `new ${score.ftHome}-${score.ftAway} (${score.source})`,
          );
          return "disputed";
        }
      }
    } catch (err) {
      logger.warn(
        "MatchScores",
        `Dispute check for ${score.eventId} failed: ${(err as Error).message}`,
      );
    }
    return "kept";
  } catch (err) {
    logger.error(
      "MatchScores",
      `saveScoreIfAbsent(${score.eventId}) failed: ${(err as Error).message}`,
    );
    throw err;
  }
};

export const upsertScoreForce = async (score: MatchScore): Promise<void> => {
  await db
    .insert(matchScores)
    .values({
      eventId: score.eventId,
      status: score.status,
      htHome: score.htHome,
      htAway: score.htAway,
      ftHome: score.ftHome,
      ftAway: score.ftAway,
      etHome: score.etHome ?? null,
      etAway: score.etAway ?? null,
      penHome: score.penHome ?? null,
      penAway: score.penAway ?? null,
      cornersHome: score.cornersHome ?? null,
      cornersAway: score.cornersAway ?? null,
      htCornersHome: score.htCornersHome ?? null,
      htCornersAway: score.htCornersAway ?? null,
      bookingsHome: score.bookingsHome ?? null,
      bookingsAway: score.bookingsAway ?? null,
      source: score.source,
      confidence: score.confidence,
      sourceUrl: score.sourceUrl ?? null,
    })
    .onConflictDoUpdate({
      target: matchScores.eventId,
      set: {
        status: score.status,
        htHome: score.htHome,
        htAway: score.htAway,
        ftHome: score.ftHome,
        ftAway: score.ftAway,
        etHome: score.etHome ?? null,
        etAway: score.etAway ?? null,
        penHome: score.penHome ?? null,
        penAway: score.penAway ?? null,
        cornersHome: score.cornersHome ?? null,
        cornersAway: score.cornersAway ?? null,
        htCornersHome: score.htCornersHome ?? null,
        htCornersAway: score.htCornersAway ?? null,
        bookingsHome: score.bookingsHome ?? null,
        bookingsAway: score.bookingsAway ?? null,
        source: score.source,
        confidence: score.confidence,
        sourceUrl: score.sourceUrl ?? null,
      },
    });
};
