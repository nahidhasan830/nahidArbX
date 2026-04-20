"use client";

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, TrendingUp, Lightbulb } from "lucide-react";

// ============================================
// Types
// ============================================

interface FailurePattern {
  patternType: "team_alias" | "competition_alias" | "time_offset";
  occurrences: number;
  suggestedFix: string;
  key: string;
}

interface DiagnosticReport {
  generatedAt: string;
  summary: {
    totalNearMatches: number;
    byProvider: Record<string, number>;
    byFailureType: Record<string, number>;
    avgScore: number;
    scoreDistribution: { range: string; count: number }[];
  };
  patterns: FailurePattern[];
  recommendations: string[];
}

interface DiagnosticStats {
  totalNearMatches: number;
  pending: number;
  confirmed: number;
  rejected: number;
  avgScore: number;
}

interface AliasStats {
  teamAliases: number;
  competitionAliases: number;
  autoLearned: number;
  manual: number;
}

interface DiagnosticsReportProps {
  stats: DiagnosticStats | null;
  report: DiagnosticReport | null;
  aliasStats: AliasStats | null;
  isLoading?: boolean;
}

// ============================================
// Component
// ============================================

export function DiagnosticsReport({
  stats,
  report,
  aliasStats,
  isLoading,
}: DiagnosticsReportProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!stats || !report) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No diagnostic data available yet. Run a sync to detect near-matches.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          title="Near-Matches"
          value={stats.totalNearMatches}
          subtitle={`${stats.pending} pending`}
          color="blue"
        />
        <StatCard
          title="Confirmed"
          value={stats.confirmed}
          subtitle="Learned as aliases"
          color="green"
        />
        <StatCard
          title="Avg Score"
          value={`${Math.round(stats.avgScore * 100)}%`}
          subtitle="Match similarity"
          color="yellow"
        />
        <StatCard
          title="Total Aliases"
          value={
            (aliasStats?.teamAliases || 0) +
            (aliasStats?.competitionAliases || 0)
          }
          subtitle={`${aliasStats?.autoLearned || 0} auto-learned`}
          color="purple"
        />
      </div>

      {/* Score Distribution */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">
            Score Distribution
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {report.summary.scoreDistribution.map((dist) => (
              <div key={dist.range} className="flex items-center gap-3">
                <span className="w-20 text-xs text-muted-foreground font-mono">
                  {dist.range}
                </span>
                <Progress
                  value={
                    report.summary.totalNearMatches > 0
                      ? (dist.count / report.summary.totalNearMatches) * 100
                      : 0
                  }
                  className="flex-1 h-2"
                />
                <span className="w-8 text-xs text-right">{dist.count}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Failure Types */}
      {Object.keys(report.summary.byFailureType).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Failure Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(report.summary.byFailureType).map(
                ([type, count]) => (
                  <Badge key={type} variant="secondary" className="text-xs">
                    {type.replace(/_/g, " ")}: {count}
                  </Badge>
                ),
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detected Patterns */}
      {report.patterns.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Detected Patterns
            </CardTitle>
            <CardDescription>
              Recurring issues that could be fixed with aliases
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {report.patterns.slice(0, 5).map((pattern) => (
                <div
                  key={pattern.key}
                  className="flex items-center justify-between p-2 bg-muted/50 rounded text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs capitalize">
                      {pattern.patternType.replace(/_/g, " ")}
                    </Badge>
                    <span className="text-muted-foreground">
                      {pattern.suggestedFix}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {pattern.occurrences}x
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      {report.recommendations.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Lightbulb className="w-4 h-4" />
              Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {report.recommendations.map((rec, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-muted-foreground">•</span>
                  <span>{rec}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================
// Stat Card
// ============================================

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle: string;
  color: "blue" | "green" | "yellow" | "purple";
}

function StatCard({ title, value, subtitle, color }: StatCardProps) {
  const colorClasses = {
    blue: "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800",
    green:
      "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800",
    yellow:
      "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800",
    purple:
      "bg-violet-50 dark:bg-violet-950 border-violet-200 dark:border-violet-800",
  };

  return (
    <div className={`p-4 rounded-lg border ${colorClasses[color]}`}>
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
    </div>
  );
}

export default DiagnosticsReport;
