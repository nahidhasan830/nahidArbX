/**
 * ML feature contract.
 *
 * This module is intentionally runtime-light: it must stay safe to import from
 * scripts and tests that only verify feature ordering/hash and do not have a
 * database connection.
 */

import { createHash } from "node:crypto";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";

export const FEATURE_NAMES: string[] = [
  "ev_pct", // 0
  "sharp_true_prob", // 1
  "soft_odds", // 2
  "adjusted_soft_odds", // 3
  "implied_prob_gap", // 4
  "tick_count", // 5
  "time_to_kickoff_min", // 6
  "movement_pct_sharp", // 7
  "movement_pct_soft", // 8
  "steam_move_sharp", // 9
  "steam_move_soft", // 10
  "sharp_direction", // 11
  "soft_direction", // 12
  "convergence_rate", // 13
  "tick_velocity", // 14
  "provider_count", // 15
  "opening_sharp_odds", // 16
  "market_type_encoded", // 17
  "is_asian_line", // 18
  "kelly_fraction_raw", // 19
  "vig_pct", // 20
  "competition_tier", // 21
  "hours_since_line_opened", // 22
  "sharp_soft_spread", // 23
  "num_markets_same_event", // 24
];

export const FEATURE_COUNT = ML_FEATURE_COUNT;
export const FEATURE_VERSION = ML_FEATURE_VERSION;
export const FEATURE_NAMES_HASH = createHash("sha256")
  .update(FEATURE_NAMES.join(","))
  .digest("hex");
