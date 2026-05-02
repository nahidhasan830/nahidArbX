"""Feature name contract — must match lib/ml/features.ts:FEATURE_NAMES exactly.

This list defines the column order of the 23-dimension feature vector stored
in bets.ml_features.  If the TypeScript extractor changes order or adds a
feature, this file MUST be updated in the same commit.

The ONNX exporter embeds these names in model metadata so the Node.js scorer
can validate at load time that its feature vector matches the model's expected
input layout.
"""

from __future__ import annotations

FEATURE_NAMES: list[str] = [
    "ev_pct",                # 0
    "sharp_true_prob",       # 1
    "soft_odds",             # 2
    "adjusted_soft_odds",    # 3
    "implied_prob_gap",      # 4
    "soft_odds_age_ms",      # 5
    "tick_count",            # 6
    "time_to_kickoff_min",   # 7
    "movement_pct_sharp",    # 8
    "movement_pct_soft",     # 9
    "steam_move_sharp",      # 10
    "steam_move_soft",       # 11
    "sharp_direction",       # 12
    "soft_direction",        # 13
    "convergence_rate",      # 14
    "tick_velocity",         # 15
    "provider_count",        # 16
    "opening_sharp_odds",    # 17
    "market_type_encoded",   # 18
    "is_asian_line",         # 19
    "commission_pct",        # 20
    "kelly_fraction_raw",    # 21
    "vig_pct",               # 22
]

FEATURE_COUNT = 23

assert len(FEATURE_NAMES) == FEATURE_COUNT, (
    f"Feature name list has {len(FEATURE_NAMES)} entries, expected {FEATURE_COUNT}"
)
