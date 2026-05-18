/**
 * ADWIN Drift Detector — concept drift detection for ML model performance.
 *
 * ADWIN (ADaptive WINdowing) maintains a variable-length window of recent
 * observations and shrinks it whenever two sub-windows show a statistically
 * significant difference in their means. Window shrinkage = concept drift.
 *
 * This module wraps ADWIN to track multiple performance metrics for the
 * deployed ML model. When drift is detected on any metric, the retraining
 * scheduler is notified (potentially triggering a shorter cadence retrain).
 *
 * Metrics tracked:
 *   - unitReturn: per-bet unit return (settled OOS bets only)
 *   - winRate:   0/1 outcome signals
 *   - mlScoreBias: difference between predicted score and actual outcome
 *
 * References:
 *   - Bifet & Gavaldà (2007), "Learning from Time-Changing Data with Adaptive Windowing"
 *   - Based on Python library's ADWIN and river's implementation
 */

import { singleton } from "../util/singleton";
import { logger } from "../shared/logger";

// ── ADWIN algorithm parameters ───────────────────────────────────────

/** Confidence parameter δ — lower = more sensitive to drift, higher = fewer false positives. */
const DELTA = 0.002;

/** Minimum sub-window length for comparison. Prevents spurious drift on tiny windows. */
const MIN_SUB_WINDOW = 10;

/** Minimum window length before checking for drift. */
const MIN_WINDOW = 30;

/** Maximum window length — cap to bound memory. */
const MAX_WINDOW = 5000;

/** Minimum number of window shrinks before triggering a drift alert. */
const MIN_SHRINKS_FOR_ALERT = 3;

/** Cooldown period between drift alerts (ms). Prevents retrain storm. */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ── Config ════════════════════════════════════════════════════════════

interface AdwinConfig {
  delta: number;
  minSubWindow: number;
  minWindow: number;
  maxWindow: number;
}

// ── Types ─────────────────────────────────────────────────────────────

interface AdwinBucket {
  /** Sum of values in this bucket. */
  total: number;
  /** Variance accumulator: sum of (value - mean)^2. */
  variance: number;
  /** Number of observations in this bucket. */
  count: number;
}

class AdwinInstance {
  private buckets: AdwinBucket[];
  private config: AdwinConfig;
  private shrinks: number;
  private totalObservations: number;

  constructor(config: Partial<AdwinConfig> = {}) {
    this.config = {
      delta: config.delta ?? DELTA,
      minSubWindow: config.minSubWindow ?? MIN_SUB_WINDOW,
      minWindow: config.minWindow ?? MIN_WINDOW,
      maxWindow: config.maxWindow ?? MAX_WINDOW,
    };
    this.buckets = [];
    this.shrinks = 0;
    this.totalObservations = 0;
  }

  /**
   * Observe a new value and check for drift.
   * @returns true if concept drift was detected (window was shrunk).
   */
  observe(value: number): boolean {
    if (!Number.isFinite(value)) return false;

    this.totalObservations++;

    // Insert new bucket with singleton observation
    const newBucket: AdwinBucket = {
      total: value,
      variance: 0,
      count: 1,
    };

    this.buckets.push(newBucket);

    // Compress: merge first two buckets if the total count exceeds maxWindow
    while (this.getWindowLength() > this.config.maxWindow) {
      this.compressBuckets(0, 1);
    }

    // Not enough data for drift detection
    if (this.getWindowLength() < this.config.minWindow) return false;

    // Drift detection: search for cut point
    let driftDetected = false;
    for (let cut = 0; cut < this.buckets.length; cut++) {
      // Check if both sub-windows are large enough
      const w0Count = this.bucketSum(cut + 1, this.buckets.length);
      const w1Count = this.bucketSum(0, cut + 1);

      if (w0Count < this.config.minSubWindow || w1Count < this.config.minSubWindow) {
        continue;
      }

      const w0Total = this.bucketSumTotal(cut + 1, this.buckets.length);
      const w1Total = this.bucketSumTotal(0, cut + 1);

      const mu0 = w0Total / w0Count;
      const mu1 = w1Total / w1Count;

      if (Math.abs(mu0 - mu1) < 1e-12) continue;

      // Hoeffding bound-based test
      // n = 1 / (1/w0Count + 1/w1Count) — harmonic mean
      const nHarmonic = 1 / (1 / w0Count + 1 / w1Count);
      // δ' = δ / log(n) — Bonferroni-like correction for window length
      const deltaPrime = this.config.delta / Math.log(this.totalObservations);

      // epsilon = sqrt(1/(2 * nHarmonic) * ln(2/deltaPrime))
      const epsilon = Math.sqrt(
        (1 / (2 * nHarmonic)) * Math.log(2 / deltaPrime),
      );

      if (Math.abs(mu0 - mu1) > epsilon) {
        // Drift detected: drop older sub-window (w0)
        this.buckets = this.buckets.slice(cut + 1);
        driftDetected = true;
        break;
      }
    }

    if (driftDetected) {
      this.shrinks++;
    }

    return driftDetected;
  }

  getWindowLength(): number {
    return this.buckets.reduce((sum, b) => sum + b.count, 0);
  }

  getShrinks(): number {
    return this.shrinks;
  }

  getMean(): number {
    const total = this.buckets.reduce((sum, b) => sum + b.total, 0);
    const count = this.getWindowLength();
    return count > 0 ? total / count : 0;
  }

  getStats() {
    return {
      windowLength: this.getWindowLength(),
      shrinks: this.shrinks,
      mean: this.getMean(),
      totalObservations: this.totalObservations,
    };
  }

  /** Number of observations in buckets [start, end). */
  private bucketSum(start: number, end: number): number {
    return this.buckets.slice(start, end).reduce((s, b) => s + b.count, 0);
  }

  /** Sum of values in buckets [start, end). */
  private bucketSumTotal(start: number, end: number): number {
    return this.buckets.slice(start, end).reduce((s, b) => s + b.total, 0);
  }

  /** Merge bucket at idx into idx+1 for memory compression. */
  private compressBuckets(idxA: number, idxB: number): void {
    const a = this.buckets[idxA];
    const b = this.buckets[idxB];
    if (!a || !b) return;

    const merged: AdwinBucket = {
      total: a.total + b.total,
      variance: a.variance + b.variance,
      count: a.count + b.count,
    };
    this.buckets[idxA] = merged;
    this.buckets.splice(idxB, 1);
  }
}

// ── Multi-metric drift tracker ────────────────────────────────────────

interface DriftTrackerState {
  unitReturn: AdwinInstance;
  winRate: AdwinInstance;
  mlScoreBias: AdwinInstance;
  lastObservationAt: number | null;
  totalObservations: number;
  consecutiveShrinks: number;
  lastAlertAt: number;
  /** Permission level before drift degradation (null if no active degradation). */
  preDriftPermissionLevel: string | null;
  /** Whether permission has been degraded due to drift. */
  permissionDegraded: boolean;
  /** When the degradation was applied (for cooldown). */
  degradedAt: number;
}

const tracker = singleton<DriftTrackerState>("ml:drift-tracker", () => ({
  unitReturn: new AdwinInstance(),
  winRate: new AdwinInstance(),
  mlScoreBias: new AdwinInstance(),
  lastObservationAt: null,
  totalObservations: 0,
  consecutiveShrinks: 0,
  lastAlertAt: 0,
  preDriftPermissionLevel: null,
  permissionDegraded: false,
  degradedAt: 0,
}));

// ── Types ─────────────────────────────────────────────────────────────

export interface DriftObservation {
  unitReturn: number | null;
  outcome: 1 | 0 | null; // 1 = win, 0 = loss (void excluded)
  mlScore: number | null;
}

export interface DriftStatus {
  driftDetected: boolean;
  driftMetrics: string[];
  unitReturnShrinks: number;
  winRateShrinks: number;
  mlScoreBiasShrinks: number;
  windowLength: number;
  totalObservations: number;
  lastObservationAt: number | null;
  allowRetrain: boolean;
  retrainCooldownRemainingMs: number;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Feed a settled bet observation into the drift detector.
 * Void outcomes are skipped (no signal).
 */
export function observeBet(obs: DriftObservation): void {
  if (obs.unitReturn != null && Number.isFinite(obs.unitReturn)) {
    tracker.unitReturn.observe(obs.unitReturn);
  }

  if (obs.outcome != null) {
    tracker.winRate.observe(obs.outcome);
  }

  if (obs.mlScore != null && obs.outcome != null && Number.isFinite(obs.mlScore)) {
    // Score bias: positive = overconfident (predicted higher than actual)
    const bias = obs.mlScore - obs.outcome;
    tracker.mlScoreBias.observe(bias);
  }

  tracker.lastObservationAt = Date.now();
  tracker.totalObservations++;

  // Track consecutive shrinks across metrics
  const totalShrinks =
    tracker.unitReturn.getShrinks() +
    tracker.winRate.getShrinks() +
    tracker.mlScoreBias.getShrinks();

  if (totalShrinks > 0) {
    tracker.consecutiveShrinks++;
  } else {
    tracker.consecutiveShrinks = 0;
  }
}

/**
 * Check whether concept drift has been detected.
 *
 * Returns drift status with details on which metrics drifted and whether
 * retraining is recommended (respecting cooldown).
 */
export function checkDrift(): DriftStatus {
  const unitReturnShrinks = tracker.unitReturn.getShrinks();
  const winRateShrinks = tracker.winRate.getShrinks();
  const mlScoreBiasShrinks = tracker.mlScoreBias.getShrinks();

  const metrics: string[] = [];
  if (unitReturnShrinks >= MIN_SHRINKS_FOR_ALERT) metrics.push("unitReturn");
  if (winRateShrinks >= MIN_SHRINKS_FOR_ALERT) metrics.push("winRate");
  if (mlScoreBiasShrinks >= MIN_SHRINKS_FOR_ALERT) metrics.push("mlScoreBias");

  const driftDetected = metrics.length > 0;

  // Cooldown check
  const now = Date.now();
  const retrainCooldownRemainingMs = Math.max(
    0,
    tracker.lastAlertAt + ALERT_COOLDOWN_MS - now,
  );
  const allowRetrain = driftDetected && retrainCooldownRemainingMs === 0;

  if (allowRetrain) {
    tracker.lastAlertAt = now;
  }

  return {
    driftDetected,
    driftMetrics: metrics,
    unitReturnShrinks,
    winRateShrinks,
    mlScoreBiasShrinks,
    windowLength: tracker.unitReturn.getWindowLength(),
    totalObservations: tracker.totalObservations,
    lastObservationAt: tracker.lastObservationAt,
    allowRetrain,
    retrainCooldownRemainingMs,
  };
}

/**
 * Get detailed ADWIN stats for diagnostics.
 */
export function getDriftStats() {
  return {
    unitReturn: tracker.unitReturn.getStats(),
    winRate: tracker.winRate.getStats(),
    mlScoreBias: tracker.mlScoreBias.getStats(),
    totalObservations: tracker.totalObservations,
    lastObservationAt: tracker.lastObservationAt,
    consecutiveShrinks: tracker.consecutiveShrinks,
    lastAlertAt: tracker.lastAlertAt,
  };
}

// ── Calibration decay monitoring
const PERMISSION_ORDER: Record<string, number> = {
  observe: 0,
  gate_only: 1,
  stake_reduce: 2,
  stake_increase: 3,
};

const PERMISSION_NAMES: Record<number, string> = {
  0: "observe",
  1: "gate_only",
  2: "stake_reduce",
  3: "stake_increase",
};

/**
 * Degrade the current permission level one step due to drift.
 *
 * Called immediately when drift is detected — the model steps back BEFORE
 * retraining completes. This prevents a drifting model from continuing
 * to affect live bets while we wait for a new one.
 *
 * @returns the new (degraded) permission level, or null if no degradation needed.
 */
export function computeDriftDegradation(
  currentLevel: string,
): string | null {
  const currentIdx = PERMISSION_ORDER[currentLevel];
  if (currentIdx === undefined || currentIdx <= 0) {
    return null; // Already at shadow, can't go lower
  }

  const newIdx = currentIdx - 1;
  const newLevel = PERMISSION_NAMES[newIdx];
  if (!newLevel) return null;

  tracker.preDriftPermissionLevel = currentLevel;
  tracker.permissionDegraded = true;
  tracker.degradedAt = Date.now();

  logger.warn(
    "MLDrift",
    `Permission degraded from ${currentLevel} → ${newLevel} due to concept drift. ` +
      `Model will step back to observation-only until retraining succeeds.`,
  );

  return newLevel;
}

/**
 * Clear drift degradation (called when a new model successfully deploys).
 * Restores the original permission level if the degradation was active.
 */
export function clearDriftDegradation(): string | null {
  if (!tracker.permissionDegraded) return null;

  const restored = tracker.preDriftPermissionLevel;
  tracker.permissionDegraded = false;
  tracker.preDriftPermissionLevel = null;
  tracker.degradedAt = 0;

  if (restored) {
    logger.info("MLDrift", `Drift degradation cleared. Permission restored to ${restored}.`);
  }
  return restored;
}

/**
 * Get current drift degradation status for diagnostics.
 */
export function getDriftDegradationStatus() {
  return {
    degraded: tracker.permissionDegraded,
    preDriftLevel: tracker.preDriftPermissionLevel,
    degradedAt: tracker.degradedAt,
    degradedDurationMs:
      tracker.permissionDegraded && tracker.degradedAt > 0
        ? Date.now() - tracker.degradedAt
        : 0,
  };
}

// ── Calibration decay monitoring ─────────────────────────────────────

const CAL_CHECK_WINDOW = 200;
const CAL_ECE_THRESHOLD = 0.15;
const CAL_MIN_SAMPLES = 50;

export interface CalibrationHealth {
  checked: boolean;
  sampleSize: number;
  ece: number;
  eceExceeded: boolean;
  meanScore: number;
  winRate: number;
}

export async function checkCalibrationHealth(): Promise<CalibrationHealth> {
  try {
    const { db } = await import("../db/client");
    const { bets } = await import("../db/schema");
    const { desc, isNotNull, and, ne } = await import("drizzle-orm");

    const rows = await db
      .select({ mlScore: bets.mlScore, outcome: bets.outcome })
      .from(bets)
      .where(
        and(
          isNotNull(bets.mlScore),
          isNotNull(bets.outcome),
          ne(bets.outcome, "void"),
          ne(bets.outcome, "pending"),
        ),
      )
      .orderBy(desc(bets.settledAt))
      .limit(CAL_CHECK_WINDOW);

    if (rows.length < CAL_MIN_SAMPLES) {
      return { checked: false, sampleSize: rows.length, ece: 0, eceExceeded: false, meanScore: 0, winRate: 0 };
    }

    const scores = rows.map((r) => r.mlScore ?? 0);
    const labels = rows.map((r) => (r.outcome === "won" || r.outcome === "half_won" ? 1 : 0));

    const ece = computeECE(scores, labels);
    const meanScore = scores.reduce((a: number, b) => a + b, 0) / scores.length;
    const winRate = labels.reduce((a: number, b) => a + b, 0) / labels.length;
    const exceeded = ece > CAL_ECE_THRESHOLD;

    if (exceeded) {
      logger.warn(
        "MLCalibration",
        `Calibration decay: ECE=${ece.toFixed(4)} > threshold=${CAL_ECE_THRESHOLD} (n=${rows.length})`,
      );
    }

    return { checked: true, sampleSize: rows.length, ece, eceExceeded: exceeded, meanScore, winRate };
  } catch (err) {
    logger.warn("MLCalibration", `Calibration check failed: ${(err as Error).message}`);
    return { checked: false, sampleSize: 0, ece: 0, eceExceeded: false, meanScore: 0, winRate: 0 };
  }
}

function computeECE(yProb: number[], yTrue: number[], nBins: number = 10): number {
  const n = yProb.length;
  if (n === 0) return 0;
  const binEdges = Array.from({ length: nBins + 1 }, (_, i) => i / nBins);
  let eceTotal = 0;
  for (let i = 0; i < nBins; i++) {
    const lo = binEdges[i];
    const hi = i === nBins - 1 ? 1.0001 : binEdges[i + 1];
    let sumPred = 0, sumTrue = 0, count = 0;
    for (let j = 0; j < n; j++) {
      if (yProb[j] >= lo && yProb[j] < hi) { sumPred += yProb[j]; sumTrue += yTrue[j]; count++; }
    }
    if (count > 0) {
      eceTotal += (count / n) * Math.abs(sumPred / count - sumTrue / count);
    }
  }
  return eceTotal;
}
