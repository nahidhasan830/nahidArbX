import numpy as np
import polars as pl
from app.evaluator import _compute_pnl

def test_smoke():
    stake = np.array([100.0, 100.0, 100.0, 100.0, 100.0])
    odds = np.array([2.0, 2.0, 2.0, 2.0, 2.0])
    commission = np.array([2.0, 2.0, 2.0, 2.0, 2.0])
    outcomes = np.array(["won", "half_won", "lost", "half_lost", "void"])
    
    pnls = _compute_pnl(stake, odds, commission, outcomes)
    
    print("Python PNLs:", pnls)
    print("Python Total PNL:", pnls.sum())
    
    settled_count = outcomes.size
    wins_full = np.sum(outcomes == "won")
    wins_half = np.sum(outcomes == "half_won")
    win_rate_pct = (
        (float(wins_full + wins_half * 0.5) / settled_count * 100.0)
        if settled_count > 0 else 0.0
    )
    print("Python Win Rate:", win_rate_pct, "%")

if __name__ == "__main__":
    test_smoke()
