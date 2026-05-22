import type { RungDefinition } from "./types";

export const rung11ScoreQuality: RungDefinition = {
  id: "score_quality",
  number: 11,
  category: "quality",
  title: "Score quality is monotonic across edge buckets",
  prereqs: ["inference_reachable"],
  evaluate: (d) => {
    const buckets = (d.scoreBucketROI ?? []).filter((b) => b.count > 0);

    if (buckets.length < 2) {
      return {
        status: "pending",
        primary: "not enough data",
        secondary:
          "fewer than two non-empty model-edge buckets — can't measure monotonicity yet.",
      };
    }

    let monotonic = true;
    for (let i = 1; i < buckets.length; i++) {
      if (buckets[i].avgPnl < buckets[i - 1].avgPnl - 0.5) {
        monotonic = false;
        break;
      }
    }
    const top = buckets[buckets.length - 1];
    const bottom = buckets[0];
    const spread = top.avgPnl - bottom.avgPnl;

    if (monotonic && spread > 0) {
      return {
        status: "pass",
        primary: `${spread.toFixed(1)}pp spread`,
        secondary: `top edge bucket (${top.bucket}) earns ${top.avgPnl.toFixed(1)}% vs bottom (${bottom.bucket}) at ${bottom.avgPnl.toFixed(1)}%.`,
      };
    }

    return {
      status: "warn",
      primary: monotonic ? `flat (${spread.toFixed(1)}pp)` : "non-monotonic",
      secondary: monotonic
        ? "ROI doesn't separate across edge buckets — model isn't learning useful signal."
        : "higher edge buckets do not produce higher ROI — calibration is broken.",
      action:
        "Treat current model as observe-only. Retrain after more data or revisit feature engineering.",
    };
  },
  inputs: (d) =>
    (d.scoreBucketROI ?? []).map((b) => ({
      label: `bucket ${b.bucket}`,
      value: `n=${b.count}, ROI=${b.avgPnl.toFixed(2)}%, win=${b.winRate.toFixed(1)}%`,
    })),
  evidence: {
    assertion:
      "scoreBucketROI is monotonically non-decreasing in avgPnl from low to high edge",
    sourceFile: "services/optimizer/app/scoring.py:score_bucket_report",
    why: "If higher predicted edge doesn't produce higher realized return, the model is well-calibrated noise. Stake-affecting permissions are unsafe.",
  },
};
