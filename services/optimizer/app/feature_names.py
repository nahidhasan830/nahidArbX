"""Feature name contract — must match lib/ml/features.ts:FEATURE_NAMES exactly.

This list defines the column order of the 22-dimension feature vector stored
in bets.ml_features.  If the TypeScript extractor changes order or adds a
feature, this file MUST be updated in the same commit.

The ONNX exporter embeds these names in model metadata so the Node.js scorer
can validate at load time that its feature vector matches the model's expected
input layout.
"""

from __future__ import annotations

import hashlib

FEATURE_NAMES: list[str] = [
    "sharp_true_prob",       # 0
    "soft_odds",             # 1
    "adjusted_soft_odds",    # 2
    "tick_count",            # 3
    "time_to_kickoff_min",   # 4
    "movement_pct_sharp",    # 5
    "movement_pct_soft",     # 6
    "steam_move_sharp",      # 7
    "steam_move_soft",       # 8
    "sharp_direction",       # 9
    "soft_direction",        # 10
    "convergence_rate",      # 11
    "tick_velocity",         # 12
    "provider_count",        # 13
    "opening_sharp_odds",    # 14
    "market_type_encoded",   # 15
    "is_asian_line",         # 16
    "vig_pct",               # 17
    "competition_tier",      # 18
    "hours_since_line_opened", # 19
    "sharp_soft_spread",     # 20
    "num_markets_same_event", # 21
]

FEATURE_COUNT = 22
FEATURE_VERSION = 1
FEATURE_NAMES_HASH = hashlib.sha256(",".join(FEATURE_NAMES).encode("utf-8")).hexdigest()

assert len(FEATURE_NAMES) == FEATURE_COUNT, (
    f"Feature name list has {len(FEATURE_NAMES)} entries, expected {FEATURE_COUNT}"
)
