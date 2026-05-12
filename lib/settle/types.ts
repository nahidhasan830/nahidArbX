import type { Outcome } from "../bets-history/types";

export type MatchStatus = "FT" | "AET" | "PEN" | "ABD" | "POSTPONED";

export type ScoreSource =
  | "pinnacle-ws"
  | "betconstruct"
  | "football-data"
  | "espn"
  | "api-football"
  | "sofascore"
  | "openligadb"
  | "pinnacle-settled"
  | "ai-search-hf"
  | "ai-search-groq"   // legacy — kept for old DB rows; new rows use ai-search-hf
  | "url-context"     // legacy — no longer produced, but old DB rows have this
  | "gemini-batch"    // legacy — no longer produced, but old DB rows have this
  | "legacy-ai"
  | "manual";

/**
 * A resolved match result. All goals are regulation (FT) — extra time and
 * penalties are tracked separately so AH/OU markets aren't polluted by ET.
 *
 * Optional stat fields (corners, cards) are only populated when a tier
 * that can provide them runs AND the batch contains a market that needs
 * them. Settler returns `unsupported-market` when the required stat is
 * missing rather than guessing.
 */
export interface MatchScore {
  eventId: string;
  status: MatchStatus;
  /** Goals at 45' + stoppage. Null when the source only reports FT. */
  htHome: number | null;
  htAway: number | null;
  /** Goals at 90' + stoppage, excluding ET and penalties. */
  ftHome: number;
  ftAway: number;
  etHome?: number | null;
  etAway?: number | null;
  penHome?: number | null;
  penAway?: number | null;
  /** Total corners (FT). `null` when not fetched or source doesn't expose. */
  cornersHome?: number | null;
  cornersAway?: number | null;
  /** Half-time corners, rarely available — best-effort only. */
  htCornersHome?: number | null;
  htCornersAway?: number | null;
  /**
   * Booking points per team (FT). Pinnacle convention:
   * 1 pt per yellow card + 2 pts per red card.
   * `null` when not fetched or source doesn't expose card stats.
   */
  bookingsHome?: number | null;
  bookingsAway?: number | null;
  source: ScoreSource;
  confidence: number;
  sourceUrl?: string | null;
  fetchedAt?: string;
}

export type SettleReason =
  | "resolved"
  | "abandoned"
  | "postponed"
  | "unsupported-market"
  | "missing-ht-score"
  | "unknown-atom";

export interface SettleResult {
  outcome: Outcome;
  /** Score in "home-away" form for the relevant scope (FT / 1H / 2H). */
  scopeScore: string;
  /** Deterministic settlement is always 1.0 — AI tiers emit lower values. */
  confidence: number;
  reasoning: string;
  reason: SettleReason;
}
