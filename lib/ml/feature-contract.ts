
import { createHash } from "node:crypto";
import { ML_FEATURE_COUNT, ML_FEATURE_VERSION } from "@/lib/shared/constants";

export const FEATURE_NAMES: string[] = [
  "sharp_true_prob", // 0
  "soft_odds", // 1
  "adjusted_soft_odds", // 2
  "tick_count", // 3
  "time_to_kickoff_min", // 4
  "movement_pct_sharp", // 5
  "movement_pct_soft", // 6
  "steam_move_sharp", // 7
  "steam_move_soft", // 8
  "sharp_direction", // 9
  "soft_direction", // 10
  "convergence_rate", // 11
  "tick_velocity", // 12
  "provider_count", // 13
  "opening_sharp_odds", // 14
  "market_type_encoded", // 15
  "is_asian_line", // 16
  "vig_pct", // 17
  "competition_tier", // 18
  "hours_since_line_opened", // 19
  "sharp_soft_spread", // 20
  "num_markets_same_event", // 21
];

export const FEATURE_COUNT = ML_FEATURE_COUNT;
export const FEATURE_VERSION = ML_FEATURE_VERSION;
export const FEATURE_INDEX = Object.freeze(
  Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, index])),
) as Record<string, number>;
export const FEATURE_SQL_INDEX = Object.freeze(
  Object.fromEntries(FEATURE_NAMES.map((name, index) => [name, index + 1])),
) as Record<string, number>;
export const FEATURE_NAMES_HASH = createHash("sha256")
  .update(FEATURE_NAMES.join(","))
  .digest("hex");
