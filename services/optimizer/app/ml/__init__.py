"""AlphaSearch Phase 4 — ML alternative (XGBoost/LightGBM).

Runs through the SAME CPCV harness as the rule-based optimizer:
  - features.py: bet row → feature vector (numerical + one-hot)
  - model.py:    XGBoost classifier + isotonic calibration
  - evaluator.py: train on CPCV train fold, predict + size on test fold

This means PBO / WRC / Pareto / DSR all apply to ML strategies too — you
can compare a rule-based config and an ML model on the same axes.
"""
