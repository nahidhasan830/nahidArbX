/**
 * Backtest-specific wrapper around the shared Google AI Mode link
 * builder. Kept for backward compatibility with existing call sites
 * (BetsHistoryTable, AiSettleDialog). New code should import
 * `buildBetGradeUrl` from `lib/shared/google-ai-link` directly.
 */
import { buildBetGradeUrl } from "@/lib/shared/google-ai-link";
import type { ValueBetRow } from "./types";

export const buildGoogleAiModeUrl = (row: ValueBetRow): string =>
  buildBetGradeUrl({
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    competition: row.competition,
    eventStartTime: row.eventStartTime,
    marketType: row.marketType,
    timeScope: row.timeScope,
    familyLine: row.familyLine,
    atomLabel: row.atomLabel,
  });

export { buildBetGradeUrl } from "@/lib/shared/google-ai-link";
export type { BetGradeDescriptor } from "@/lib/shared/google-ai-link";
