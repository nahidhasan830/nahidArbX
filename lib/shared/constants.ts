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
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30s safety-net heartbeat (detection is event-driven)
export const DEFAULT_TIMEOUT_MS = 15000;
export const PINNACLE_TIMEOUT_MS = 30000;

// Odds freshness
export const MAX_ODDS_AGE_MS = 90_000; // 90 seconds - odds older than this are stale

// Value Betting
export const MIN_EV_PCT = 2.0; // Minimum EV% to flag as value bet
export const KELLY_FRACTION = 0.25; // Quarter Kelly for risk management
export const VALUE_TOTAL_STAKE = 1000; // Default bankroll for Kelly calculation
export const MAX_VALUE_ODDS_AGE_MS = 180_000; // Max age of sharp odds snapshot used for detection (3 min — survives fixture sync delays)
// Auto-placement stake rules.
//   - BUCKET: stakes always snap to a multiple of this (100 BDT) so we
//     never submit fractional amounts like 4.69 — operator preference.
//   - MIN_AUTO_PLACE_STAKE: lower bound, must itself be a multiple of
//     BUCKET. Doubles as the backstop when getMarketLimits mis-returns a
//     1-BDT guest-tier min.
export const AUTO_PLACE_STAKE_BUCKET = 100;
export const MIN_AUTO_PLACE_STAKE = 200;

// API
export const DEFAULT_PAGE_SIZE = 1000;
export const PINNACLE_DAYS_AHEAD = 1;

// Reactive detection
export const DETECTION_DEBOUNCE_MS = 500; // Coalesce WS bursts before running value detection
export const STALE_ODDS_CLEANUP_INTERVAL_MS = 300_000; // 5 min — prune odds for events no longer in roster

// Odds movement history
export const ODDS_HISTORY_MAX_TICKS = 200; // Ring buffer capacity per atom/provider
export const STEAM_MOVE_WINDOW_MS = 60_000; // Lookback window for steam detection
export const STEAM_MOVE_MODERATE_PCT = 3; // ≥3% move in window = moderate
export const STEAM_MOVE_STRONG_PCT = 5; // ≥5% move in ≤30s = strong

// ML pipeline
export const ML_MIN_SCORE = 0.4; // Legacy UI score band only; auto-place now gates on model EV at offered odds
export const ML_COLD_START_THRESHOLD = 200; // Aligned with Python deployment gate MIN_VALID_EXAMPLES (avoids noisy rejected training runs)
export const ML_COLLECTION_TARGET = 500; // Current-contract corpus floor before expecting a useful first rebuilt model.
export const ML_FEATURE_COUNT = 22; // Dimensionality of feature vector (removed ev_pct, implied_prob_gap, kelly_fraction_raw)
export const ML_FEATURE_VERSION = 1; // Contract version for persisted ML feature vectors after the clean rebuild reset
export const ML_WARMUP_MIN_TICKS = 3; // Min sharp-provider ticks before trusting history-dependent features
export const ML_RETRAIN_GROWTH_STEP = 200; // Auto-retrain after this many new training examples since the last deployed model. Aligned with ML_COLD_START_THRESHOLD so retrain cadence matches the minimum-viable training step.
export const ML_TRAINING_STALE_TIMEOUT_MS = 45 * 60 * 1000; // Mark training placeholders failed when no launcher/job heartbeat lands for 45 minutes.

// Vertex AI Search — allowed domains (Google limit: 50 domains)
export const VERTEX_AI_ALLOWED_DOMAINS = [
  "flashscore.com/*",
  "livescore.com/*",
  "sofascore.com/*",
  "fotmob.com/*",
  "espn.com/soccer/*",
  "goal.com/*",
  "skysports.com/football/*",
  "bbc.com/sport/football/*",
  "transfermarkt.com/*",
  "onefootball.com/*",
  "365scores.com/*",
  "soccerway.com/*",
  "besoccer.com/*",
  "aiscore.com/*",
  "scorebar.com/*",
  "whoscored.com/*",
  "tribuna.com/*",
  "eurosport.com/football/*",
  "cbssports.com/soccer/*",
  "foxsports.com/soccer/*",
  "nbcsports.com/soccer/*",
  "sportingnews.com/*",
  "theathletic.com/football/*",
  "teamtalk.com/*",
  "football365.com/*",
  "sportsmole.co.uk/football/*",
  "caughtoffside.com/*",
  "football-italia.net/*",
  "givemesport.com/football/*",
  "newsnow.co.uk/h/Sport/Football/*",
  "livescore.in/*",
  "vavel.com/en/football/*",
  "mirror.co.uk/sport/football/*",
  "theguardian.com/football/*",
  "telegraph.co.uk/football/*",
  "independent.co.uk/sport/football/*",
  "dailymail.co.uk/sport/football/*",
  "thesun.co.uk/sport/football/*",
  "express.co.uk/sport/football/*",
  "marca.com/en/football/*",
  "as.com/soccer/*",
  "lequipe.fr/Football/*",
  "kicker.de/*",
  "gazzetta.it/Calcio/*",
  "msn.com/en-us/sports/soccer/*",
  "bleacherreport.com/world-football/*",
  "usatoday.com/sports/soccer/*",
  "nytimes.com/athletic/football/*",
  "scoresway.com/*",
  "90min.com/*",
] as const;
