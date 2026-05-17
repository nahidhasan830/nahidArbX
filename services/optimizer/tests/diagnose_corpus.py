#!/usr/bin/env python3
"""Diagnose the actionable corpus — why is AUC-ROC ≈ 0.50?

Prints feature-level statistics, label distributions, and tests whether
any individual feature has discriminative power (point-biserial correlation
with label).

Run:  cd services/optimizer && source .venv/bin/activate && python tests/diagnose_corpus.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
from scipy import stats

from app.db import open_session
from app.feature_names import FEATURE_NAMES
from app.loader import load_best_available


def main() -> None:
    session = open_session()
    try:
        data = load_best_available(session)
    finally:
        session.close()

    if data.n_samples == 0:
        print("No data loaded.")
        return

    n = data.n_samples
    X = data.features
    y = data.labels
    n_pos = int(y.sum())
    n_neg = n - n_pos

    print(f"\n{'='*70}")
    print(f"  Corpus diagnostics: {n} samples ({n_pos} pos, {n_neg} neg)")
    print(f"  Win rate: {n_pos/n*100:.1f}%")
    print(f"{'='*70}\n")

    # ── 1. Feature-level discriminative power ──
    print(f"{'Feature':<28} {'mean|pos':>10} {'mean|neg':>10} {'Δ':>10} {'r_pb':>8} {'p-val':>10}")
    print(f"{'─'*28} {'─'*10} {'─'*10} {'─'*10} {'─'*8} {'─'*10}")

    pos_mask = y == 1
    neg_mask = y == 0

    correlations = []
    for i, name in enumerate(FEATURE_NAMES):
        col = X[:, i].astype(np.float64)
        mean_pos = float(col[pos_mask].mean())
        mean_neg = float(col[neg_mask].mean())
        delta = mean_pos - mean_neg

        # Point-biserial correlation (= Pearson between binary label and continuous feature)
        try:
            r_pb, p_val = stats.pointbiserialr(y, col)
        except Exception:
            r_pb, p_val = 0.0, 1.0

        correlations.append((name, abs(r_pb) if not np.isnan(r_pb) else 0.0))

        sig = "***" if p_val < 0.001 else "**" if p_val < 0.01 else "*" if p_val < 0.05 else ""
        print(f"  {name:<26} {mean_pos:>10.4f} {mean_neg:>10.4f} {delta:>+10.4f} {r_pb:>+8.4f} {p_val:>10.4f} {sig}")

    print()

    # ── 2. Top features by |correlation| ──
    correlations.sort(key=lambda x: x[1], reverse=True)
    print("Top features by |point-biserial r|:")
    for name, r in correlations[:10]:
        bar = "█" * int(r * 100)
        print(f"  {name:<26} |r|={r:.4f}  {bar}")

    print()

    # ── 3. Feature variance ──
    print("Feature variance (low variance = no signal possible):")
    for i, name in enumerate(FEATURE_NAMES):
        col = X[:, i].astype(np.float64)
        var = float(col.var())
        std = float(col.std())
        mn = float(col.min())
        mx = float(col.max())
        print(f"  {name:<26} var={var:>12.4f}  std={std:>10.4f}  range=[{mn:.4f}, {mx:.4f}]")

    print()

    # ── 4. ev_pct distribution by label ──
    ev_idx = FEATURE_NAMES.index("ev_pct")
    ev = X[:, ev_idx]
    print(f"ev_pct distribution:")
    print(f"  Overall:  min={ev.min():.2f}, max={ev.max():.2f}, mean={ev.mean():.2f}, median={np.median(ev):.2f}")
    print(f"  Positive: min={ev[pos_mask].min():.2f}, max={ev[pos_mask].max():.2f}, mean={ev[pos_mask].mean():.2f}")
    print(f"  Negative: min={ev[neg_mask].min():.2f}, max={ev[neg_mask].max():.2f}, mean={ev[neg_mask].mean():.2f}")

    # ── 5. Unit return distribution ──
    if "unit_return" in data.metadata.columns:
        ur = data.metadata["unit_return"].to_numpy().astype(np.float64)
        ur = np.nan_to_num(ur, nan=0.0)
        print(f"\nunit_return distribution:")
        print(f"  Overall:  min={ur.min():.4f}, max={ur.max():.4f}, mean={ur.mean():.4f}")
        print(f"  Positive: min={ur[pos_mask].min():.4f}, max={ur[pos_mask].max():.4f}, mean={ur[pos_mask].mean():.4f}")
        print(f"  Negative: min={ur[neg_mask].min():.4f}, max={ur[neg_mask].max():.4f}, mean={ur[neg_mask].mean():.4f}")

    # ── 6. Outcome distribution ──
    if "outcome" in data.metadata.columns:
        outcomes = data.metadata["outcome"].to_list()
        from collections import Counter
        oc = Counter(outcomes)
        print(f"\nOutcome distribution: {dict(oc)}")

    # ── 7. Quick single-feature AUC check ──
    from sklearn.metrics import roc_auc_score
    print(f"\nSingle-feature AUC (each feature alone as predictor):")
    for i, name in enumerate(FEATURE_NAMES):
        col = X[:, i].astype(np.float64)
        try:
            auc = roc_auc_score(y, col)
        except ValueError:
            auc = 0.5
        # Also try negated
        try:
            auc_neg = roc_auc_score(y, -col)
        except ValueError:
            auc_neg = 0.5
        best_auc = max(auc, auc_neg)
        direction = "+" if auc >= auc_neg else "-"
        bar = "█" * int(abs(best_auc - 0.5) * 100)
        sig = " ← SIGNAL" if best_auc > 0.55 else ""
        print(f"  {name:<26} AUC={best_auc:.4f} ({direction}) {bar}{sig}")

    # ── 8. Temporal analysis ──
    if "first_seen_at" in data.metadata.columns:
        first_seen = data.metadata["first_seen_at"].to_list()
        print(f"\nTemporal range:")
        non_null = [x for x in first_seen if x is not None]
        if non_null:
            print(f"  Earliest: {min(non_null)}")
            print(f"  Latest:   {max(non_null)}")

            # Check win rate by temporal quintile
            n_quintiles = 5
            q_size = n // n_quintiles
            print(f"\n  Win rate by temporal quintile:")
            for q in range(n_quintiles):
                start = q * q_size
                end = min((q + 1) * q_size, n) if q < n_quintiles - 1 else n
                q_labels = y[start:end]
                q_wr = float(q_labels.sum()) / len(q_labels) * 100
                q_ev = float(X[start:end, ev_idx].mean())
                print(f"    Q{q+1} [{start}:{end}]: win_rate={q_wr:.1f}%, mean_ev={q_ev:.2f}%, n={len(q_labels)}")

    print("\n" + "=" * 70)
    print("DIAGNOSIS SUMMARY")
    print("=" * 70)

    any_signal = any(r > 0.1 for _, r in correlations[:5])
    if not any_signal:
        print("\n⚠ NO feature has |r_pb| > 0.10 with the label.")
        print("  This means no feature in the 25-dim vector can separate wins from losses")
        print("  in the actionable (ev_pct > 0) corpus.")
        print()
        print("  Possible root causes:")
        print("  1. The label is NOISE: once you filter to ev_pct > 0 bets, win/loss")
        print("     is driven by match randomness, not by any detectable feature.")
        print("  2. Feature staleness: features are snapshot at detection time but the")
        print("     outcome depends on closing line movement (not captured).")
        print("  3. Sample homogeneity: all 487 rows are high-EV, similar odds, similar")
        print("     markets — the features have no variance to discriminate.")
        print()
        print("  Recommendation: The ML model cannot beat the simple EV rule on this")
        print("  corpus. Consider:")
        print("    a) Adding features that capture post-detection dynamics (closing line")
        print("       movement, liquidity changes, late steam moves).")
        print("    b) Expanding the corpus to include lower-EV marginal cases where the")
        print("       model has room to separate signal from noise.")
        print("    c) Accepting that on a small, homogeneous, positive-EV corpus, the")
        print("       simple rule IS the best policy.")
    else:
        top_signal = correlations[0]
        print(f"\n✓ Some signal detected. Top feature: {top_signal[0]} |r|={top_signal[1]:.4f}")
        print("  The pipeline should be able to learn something, but 487 samples may be")
        print("  too few for 25 features + 50-trial HPO.")


if __name__ == "__main__":
    main()
