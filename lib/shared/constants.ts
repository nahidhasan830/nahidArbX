/**
 * Shared Constants
 *
 * Single source of truth for magic numbers and configuration values.
 */

// Event matching
export const MATCH_THRESHOLD = 0.85;
export const TIME_BUCKET_MS = 60 * 1000; // 1 minute — effectively exact time matching

// Sync intervals
export const SYNC_INTERVAL_MS = 60000;
export const FIXTURE_INTERVAL_MS = 120000; // 2 minutes - fixtures + matching
export const ODDS_INTERVAL_MS = 30000; // 30 seconds - odds + value detection
export const DEFAULT_TIMEOUT_MS = 15000;
export const PINNACLE_TIMEOUT_MS = 30000;

// Odds freshness
export const MAX_ODDS_AGE_MS = 90_000; // 90 seconds - odds older than this are stale

// Value Betting
export const MIN_EV_PCT = 2.0; // Minimum EV% to flag as value bet
export const KELLY_FRACTION = 0.25; // Quarter Kelly for risk management
export const VALUE_TOTAL_STAKE = 1000; // Default bankroll for Kelly calculation
export const MAX_VALUE_ODDS_AGE_MS = 90_000; // Max age of sharp odds snapshot used for detection
// Auto-placement stake rules.
//   - BUCKET: stakes always snap to a multiple of this (100 BDT) so we
//     never submit fractional amounts like 4.69 — operator preference.
//   - MIN_AUTO_PLACE_STAKE: lower bound, must itself be a multiple of
//     BUCKET. Doubles as the backstop when getMarketLimits mis-returns a
//     1-BDT guest-tier min.
export const AUTO_PLACE_STAKE_BUCKET = 100;
export const MIN_AUTO_PLACE_STAKE = 200;

// Priority Scoring (for value bet sorting)
export const PRIORITY_EV_CAP = 15; // Cap EV% at 15% (higher = palpable error)
export const PRIORITY_WEIGHT_EV = 0.5; // EV weight in priority score
export const PRIORITY_WEIGHT_KELLY = 0.3; // Kelly stake weight
export const PRIORITY_WEIGHT_FRESHNESS = 0.2; // Odds freshness weight
export const PRIORITY_SUSPICIOUS_PENALTY = 0.5; // Penalty for suspicious bets
export const PRIORITY_MAX_KELLY_PCT = 10; // Max Kelly as % of bankroll for normalization

// API
export const DEFAULT_PAGE_SIZE = 1000;
export const PINNACLE_DAYS_AHEAD = 1;
