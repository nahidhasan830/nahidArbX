"""Feature name contract — must match lib/ml/features.ts:FEATURE_NAMES exactly.

This list defines the column order of the 25-dimension feature vector stored
in bets.ml_features.  If the TypeScript extractor changes order or adds a
feature, this file MUST be updated in the same commit.

The ONNX exporter embeds these names in model metadata so the Node.js scorer
can validate at load time that its feature vector matches the model's expected
input layout.
"""

from __future__ import annotations

import hashlib

FEATURE_NAMES: list[str] = [
    "ev_pct",                # 0
    "sharp_true_prob",       # 1
    "soft_odds",             # 2
    "adjusted_soft_odds",    # 3
    "implied_prob_gap",      # 4
    "tick_count",            # 5
    "time_to_kickoff_min",   # 6
    "movement_pct_sharp",    # 7
    "movement_pct_soft",     # 8
    "steam_move_sharp",      # 9
    "steam_move_soft",       # 10
    "sharp_direction",       # 11
    "soft_direction",        # 12
    "convergence_rate",      # 13
    "tick_velocity",         # 14
    "provider_count",        # 15
    "opening_sharp_odds",    # 16
    "market_type_encoded",   # 17
    "is_asian_line",         # 18
    "kelly_fraction_raw",    # 19
    "vig_pct",               # 20
    "competition_tier",      # 21
    "hours_since_line_opened", # 22
    "sharp_soft_spread",     # 23
    "num_markets_same_event", # 24
]

FEATURE_COUNT = 25
FEATURE_VERSION = 2
FEATURE_NAMES_HASH = hashlib.sha256(",".join(FEATURE_NAMES).encode("utf-8")).hexdigest()

assert len(FEATURE_NAMES) == FEATURE_COUNT, (
    f"Feature name list has {len(FEATURE_NAMES)} entries, expected {FEATURE_COUNT}"
)
