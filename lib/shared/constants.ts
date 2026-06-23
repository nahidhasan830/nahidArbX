
export const MATCH_THRESHOLD = 0.85;
export const TIME_BUCKET_MS = 60 * 1000;

export const SYNC_INTERVAL_MS = 60000;
export const FIXTURE_INTERVAL_MS = 120000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 15000;
export const PINNACLE_TIMEOUT_MS = 30000;
export const MATCHER_LAB_AUTO_REFRESH_MS = 15_000;
export const PROVIDER_HEALTH_DEGRADED_AFTER_MS = 15 * 60 * 1000;
export const PROVIDER_HEALTH_FAILURES_DOWN = 3;
export const PROVIDER_HEALTH_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
export const LOG_RETENTION_DAYS = 7;
export const LOG_RETENTION_TTL_MS = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const LOG_RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const LOG_RETENTION_STARTUP_DELAY_MS = 30 * 1000;

export const MAX_ODDS_AGE_MS = 90_000;

export const MIN_EV_PCT = 2.0;
export const KELLY_FRACTION = 0.25;
export const VALUE_TOTAL_STAKE = 1000;
export const MAX_VALUE_ODDS_AGE_MS = 180_000;
export const AUTO_PLACE_STAKE_BUCKET = 100;
export const MIN_AUTO_PLACE_STAKE = 200;

export const DEFAULT_PAGE_SIZE = 1000;
export const PINNACLE_DAYS_AHEAD = 1;

export const DETECTION_DEBOUNCE_MS = 500;
export const STALE_ODDS_CLEANUP_INTERVAL_MS = 300_000;

export const ODDS_HISTORY_MAX_TICKS = 200;
export const STEAM_MOVE_WINDOW_MS = 60_000;
export const STEAM_MOVE_MODERATE_PCT = 3;
export const STEAM_MOVE_STRONG_PCT = 5;

export const ML_MIN_SCORE = 0.4;
export const ML_COLD_START_THRESHOLD = 200;
export const ML_COLLECTION_TARGET = 500;
export const ML_FEATURE_COUNT = 22;
export const ML_FEATURE_VERSION = 1;
export const ML_WARMUP_MIN_TICKS = 3;
export const ML_RETRAIN_GROWTH_STEP = 200;
export const ML_TRAINING_STALE_TIMEOUT_MS = 45 * 60 * 1000;

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
