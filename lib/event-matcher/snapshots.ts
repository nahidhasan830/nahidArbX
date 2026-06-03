import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  providerEventSnapshots,
  type NewProviderEventSnapshotRow,
} from "../db/schema";
import { isSabaSyntheticMarketFixture } from "../adapters/saba-filters";
import { normalize, normalizeCompetition } from "../matching/normalize";
import type { ProviderEventSnapshot, ProviderSnapshotInput } from "./types";

function stableHash(parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 32);
}

export function snapshotIdFor(input: {
  provider: string;
  providerEventId: string;
  fetchBatchId: string;
}): string {
  return stableHash([input.provider, input.providerEventId]);
}

export function toSnapshotInput(
  input: ProviderSnapshotInput,
): ProviderEventSnapshot {
  const event = input.event;
  return {
    id: snapshotIdFor(input),
    provider: input.provider,
    providerEventId: input.providerEventId,
    sport: event.sport,
    homeTeamRaw: event.homeTeam,
    awayTeamRaw: event.awayTeam,
    competitionRaw: event.competition,
    homeTeamNormalized: normalize(event.homeTeam),
    awayTeamNormalized: normalize(event.awayTeam),
    competitionNormalized: normalizeCompetition(event.competition),
    rawStartTime: input.rawStartTime ?? event.startTime.toISOString(),
    parsedKickoff: event.startTime,
    parseStrategy: input.parseStrategy ?? "adapter-normalized-date",
    fetchBatchId: input.fetchBatchId,
    providerMetadata: input.providerMetadata ?? null,
    rawPayload: input.rawPayload ?? null,
  };
}

export async function captureProviderSnapshots(
  inputs: ProviderSnapshotInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const filteredInputs = inputs.filter(
    (input) =>
      !isSabaSyntheticMarketFixture({
        provider: input.provider,
        homeTeam: input.event.homeTeam,
        awayTeam: input.event.awayTeam,
        competition: input.event.competition,
      }),
  );
  if (filteredInputs.length === 0) return 0;

  const rows = filteredInputs.map((input): NewProviderEventSnapshotRow => {
    const s = toSnapshotInput(input);
    return {
      id: s.id,
      provider: s.provider,
      providerEventId: s.providerEventId,
      sport: s.sport,
      homeTeamRaw: s.homeTeamRaw,
      awayTeamRaw: s.awayTeamRaw,
      competitionRaw: s.competitionRaw,
      homeTeamNormalized: s.homeTeamNormalized,
      awayTeamNormalized: s.awayTeamNormalized,
      competitionNormalized: s.competitionNormalized,
      rawStartTime: s.rawStartTime,
      parsedKickoff: s.parsedKickoff.toISOString(),
      parseStrategy: s.parseStrategy,
      fetchBatchId: s.fetchBatchId,
      providerMetadata: s.providerMetadata,
      rawPayload: s.rawPayload,
    };
  });

  await db
    .insert(providerEventSnapshots)
    .values(rows)
    .onConflictDoUpdate({
      target: providerEventSnapshots.id,
      set: {
        sport: sql`excluded.sport`,
        homeTeamRaw: sql`excluded.home_team_raw`,
        awayTeamRaw: sql`excluded.away_team_raw`,
        competitionRaw: sql`excluded.competition_raw`,
        homeTeamNormalized: sql`excluded.home_team_normalized`,
        awayTeamNormalized: sql`excluded.away_team_normalized`,
        competitionNormalized: sql`excluded.competition_normalized`,
        rawStartTime: sql`excluded.raw_start_time`,
        parsedKickoff: sql`excluded.parsed_kickoff`,
        parseStrategy: sql`excluded.parse_strategy`,
        fetchBatchId: sql`excluded.fetch_batch_id`,
        providerMetadata: sql`excluded.provider_metadata`,
        rawPayload: sql`excluded.raw_payload`,
        capturedAt: sql`now()`,
      },
    });
  return rows.length;
}
