/**
 * Diagnostic Reports
 *
 * Generates reports from near-match data, detecting patterns
 * and providing actionable recommendations.
 */

import type { NearMatch, FailurePattern } from "./types";
import { getNearMatches, getDiagnosticStats, setPatterns } from "./store";

// ============================================
// Types
// ============================================

export interface DiagnosticReport {
  generatedAt: Date;
  summary: {
    totalNearMatches: number;
    byProvider: Record<string, number>;
    byFailureType: Record<string, number>;
    avgScore: number;
    scoreDistribution: { range: string; count: number }[];
  };
  patterns: FailurePattern[];
  topNearMatches: NearMatch[];
  recommendations: string[];
}

// ============================================
// Report Generation
// ============================================

/**
 * Generate a comprehensive diagnostic report.
 */
export function generateDiagnosticReport(): DiagnosticReport {
  const nearMatches = getNearMatches();
  const stats = getDiagnosticStats();

  // Count by provider
  const byProvider: Record<string, number> = {};
  for (const nm of nearMatches) {
    byProvider[nm.eventA.provider] = (byProvider[nm.eventA.provider] || 0) + 1;
    byProvider[nm.eventB.provider] = (byProvider[nm.eventB.provider] || 0) + 1;
  }

  // Count by failure type
  const byFailureType: Record<string, number> = {};
  for (const nm of nearMatches) {
    for (const reason of nm.failureReasons) {
      byFailureType[reason.type] = (byFailureType[reason.type] || 0) + 1;
    }
  }

  // Score distribution
  const scoreDistribution = [
    { range: "0.70-0.74", count: 0 },
    { range: "0.75-0.79", count: 0 },
    { range: "0.80-0.84", count: 0 },
  ];
  for (const nm of nearMatches) {
    const score = nm.breakdown.finalScore;
    if (score >= 0.8) scoreDistribution[2].count++;
    else if (score >= 0.75) scoreDistribution[1].count++;
    else scoreDistribution[0].count++;
  }

  // Detect patterns
  const patterns = detectFailurePatterns(nearMatches);

  // Update stored patterns for API access
  setPatterns(patterns);

  // Generate recommendations
  const recommendations = generateRecommendations(patterns, byFailureType);

  return {
    generatedAt: new Date(),
    summary: {
      totalNearMatches: nearMatches.length,
      byProvider,
      byFailureType,
      avgScore: stats.avgScore,
      scoreDistribution,
    },
    patterns,
    topNearMatches: nearMatches.slice(0, 10), // Top 10 by score
    recommendations,
  };
}

// ============================================
// Pattern Detection
// ============================================

/**
 * Detect recurring failure patterns.
 */
function detectFailurePatterns(nearMatches: NearMatch[]): FailurePattern[] {
  const patterns: FailurePattern[] = [];

  // Group by team name pairs (for team aliases)
  const teamPairs = groupByTeamPairs(nearMatches);
  for (const [key, matches] of teamPairs) {
    if (matches.length >= 2) {
      const [teamA, teamB] = key.split("|");
      patterns.push({
        patternType: "team_alias",
        occurrences: matches.length,
        examples: matches.slice(0, 3),
        suggestedFix: `Add alias: "${teamA}" -> "${teamB}"`,
        key,
      });
    }
  }

  // Group by competition pairs
  const compPairs = groupByCompetitionPairs(nearMatches);
  for (const [key, matches] of compPairs) {
    if (matches.length >= 2) {
      const [compA, compB] = key.split("|");
      patterns.push({
        patternType: "competition_alias",
        occurrences: matches.length,
        examples: matches.slice(0, 3),
        suggestedFix: `Add alias: "${compA}" -> "${compB}"`,
        key,
      });
    }
  }

  // Detect time offset patterns by provider pair
  const timePatterns = detectTimeOffsetPatterns(nearMatches);
  patterns.push(...timePatterns);

  // Sort by occurrences
  return patterns.sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * Group near-matches by team name pairs.
 */
function groupByTeamPairs(nearMatches: NearMatch[]): Map<string, NearMatch[]> {
  const teamPairs = new Map<string, NearMatch[]>();

  for (const nm of nearMatches) {
    // Check if team mismatch was a failure reason
    const hasTeamMismatch = nm.failureReasons.some(
      (r) => r.type === "team_mismatch",
    );
    if (!hasTeamMismatch) continue;

    // Use the actual team that had low similarity
    const orientation = nm.breakdown.bestOrientation;

    // Home team comparison
    const homeA = nm.eventA.homeTeam.toLowerCase();
    const homeB =
      orientation === "normal"
        ? nm.eventB.homeTeam.toLowerCase()
        : nm.eventB.awayTeam.toLowerCase();

    if (homeA !== homeB) {
      const key = [homeA, homeB].sort().join("|");
      const existing = teamPairs.get(key) || [];
      existing.push(nm);
      teamPairs.set(key, existing);
    }

    // Away team comparison
    const awayA = nm.eventA.awayTeam.toLowerCase();
    const awayB =
      orientation === "normal"
        ? nm.eventB.awayTeam.toLowerCase()
        : nm.eventB.homeTeam.toLowerCase();

    if (awayA !== awayB) {
      const key = [awayA, awayB].sort().join("|");
      const existing = teamPairs.get(key) || [];
      existing.push(nm);
      teamPairs.set(key, existing);
    }
  }

  return teamPairs;
}

/**
 * Group near-matches by competition pairs.
 */
function groupByCompetitionPairs(
  nearMatches: NearMatch[],
): Map<string, NearMatch[]> {
  const compPairs = new Map<string, NearMatch[]>();

  for (const nm of nearMatches) {
    // Check if competition mismatch was a failure reason
    const hasCompMismatch = nm.failureReasons.some(
      (r) => r.type === "competition_mismatch",
    );
    if (!hasCompMismatch) continue;

    const compA = nm.eventA.competition.toLowerCase();
    const compB = nm.eventB.competition.toLowerCase();

    if (compA !== compB) {
      const key = [compA, compB].sort().join("|");
      const existing = compPairs.get(key) || [];
      existing.push(nm);
      compPairs.set(key, existing);
    }
  }

  return compPairs;
}

/**
 * Detect time offset patterns between provider pairs.
 */
function detectTimeOffsetPatterns(nearMatches: NearMatch[]): FailurePattern[] {
  const patterns: FailurePattern[] = [];
  const timeOffsets = new Map<
    string,
    { offsets: number[]; examples: NearMatch[] }
  >();

  for (const nm of nearMatches) {
    // Check if time mismatch was a failure reason
    const hasTimeMismatch = nm.failureReasons.some(
      (r) => r.type === "time_mismatch",
    );
    if (!hasTimeMismatch) continue;

    const key = [nm.eventA.provider, nm.eventB.provider].sort().join("-");
    const existing = timeOffsets.get(key) || { offsets: [], examples: [] };
    existing.offsets.push(nm.breakdown.timeDiffMs);
    if (existing.examples.length < 3) {
      existing.examples.push(nm);
    }
    timeOffsets.set(key, existing);
  }

  for (const [providerPair, data] of timeOffsets) {
    if (data.offsets.length >= 3) {
      const avgOffset =
        data.offsets.reduce((a, b) => a + b, 0) / data.offsets.length;
      const avgMinutes = Math.round(avgOffset / 60000);

      patterns.push({
        patternType: "time_offset",
        occurrences: data.offsets.length,
        examples: data.examples,
        suggestedFix: `Configure time tolerance for ${providerPair}: ~${avgMinutes} minutes`,
        key: providerPair,
      });
    }
  }

  return patterns;
}

// ============================================
// Recommendations
// ============================================

/**
 * Generate actionable recommendations based on patterns.
 */
function generateRecommendations(
  patterns: FailurePattern[],
  byFailureType: Record<string, number>,
): string[] {
  const recommendations: string[] = [];

  // Team alias recommendations
  const teamPatterns = patterns.filter((p) => p.patternType === "team_alias");
  if (teamPatterns.length > 0) {
    const topPatterns = teamPatterns.slice(0, 3);
    recommendations.push(
      `Found ${teamPatterns.length} recurring team name mismatches. Top suggestions: ` +
        topPatterns.map((p) => p.suggestedFix).join("; "),
    );
  }

  // Competition alias recommendations
  const compPatterns = patterns.filter(
    (p) => p.patternType === "competition_alias",
  );
  if (compPatterns.length > 0) {
    const topPatterns = compPatterns.slice(0, 3);
    recommendations.push(
      `Found ${compPatterns.length} recurring competition name mismatches. ` +
        topPatterns.map((p) => p.suggestedFix).join("; "),
    );
  }

  // Time tolerance recommendations
  const timeCount = byFailureType["time_mismatch"] || 0;
  if (timeCount > 10) {
    recommendations.push(
      `High number of time mismatches (${timeCount}). Consider increasing TIME_BUCKET_MS in constants.ts.`,
    );
  }

  // High-confidence near-matches
  const highScoreCount = patterns
    .flatMap((p) => p.examples)
    .filter((nm) => nm.breakdown.finalScore >= 0.82).length;
  if (highScoreCount > 5) {
    recommendations.push(
      `${highScoreCount} near-matches have scores >= 0.82. Consider reviewing and confirming these to learn aliases.`,
    );
  }

  return recommendations;
}

// ============================================
// Summary Functions
// ============================================

/**
 * Get a quick summary of near-match status.
 */
export function getNearMatchSummary(): {
  pending: number;
  patterns: number;
  topScore: number;
} {
  const stats = getDiagnosticStats();
  const nearMatches = getNearMatches({ status: "pending" });

  return {
    pending: stats.pending,
    patterns: stats.patterns.length,
    topScore: nearMatches.length > 0 ? nearMatches[0].breakdown.finalScore : 0,
  };
}
