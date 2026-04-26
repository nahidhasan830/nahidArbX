"use client";

import { useState, useCallback } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Check,
  X,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";

// ============================================
// Types
// ============================================

interface NearMatchEvent {
  id: string;
  provider: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  startTime: string;
}

interface MatchScoreBreakdown {
  teamScore: number;
  homeHomeSimilarity: number;
  awayAwaySimilarity: number;
  homeAwaySimilarity: number;
  awayHomeSimilarity: number;
  bestOrientation: "normal" | "swapped";
  competitionScore: number;
  competitionA: string;
  competitionB: string;
  timeScore: number;
  timeDiffMs: number;
  finalScore: number;
}

interface FailureReason {
  type: string;
  details: Record<string, unknown>;
}

interface NearMatch {
  id: string;
  eventA: NearMatchEvent;
  eventB: NearMatchEvent;
  breakdown: MatchScoreBreakdown;
  failureReasons: FailureReason[];
  status: "pending" | "confirmed" | "rejected";
  detectedAt: string;
}

interface NearMatchesPanelProps {
  nearMatches: NearMatch[];
  isLoading?: boolean;
  onConfirm: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onRefresh: () => void;
}

// ============================================
// Component
// ============================================

export function NearMatchesPanel({
  nearMatches,
  isLoading,
  onConfirm,
  onReject,
  onRefresh,
}: NearMatchesPanelProps) {
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const filteredMatches =
    filter === "pending"
      ? nearMatches.filter((nm) => nm.status === "pending")
      : nearMatches;

  const pendingCount = nearMatches.filter(
    (nm) => nm.status === "pending",
  ).length;

  const handleConfirm = useCallback(
    async (id: string) => {
      setProcessingId(id);
      try {
        await onConfirm(id);
      } finally {
        setProcessingId(null);
      }
    },
    [onConfirm],
  );

  const handleReject = useCallback(
    async (id: string) => {
      setProcessingId(id);
      try {
        await onReject(id);
      } finally {
        setProcessingId(null);
      }
    },
    [onReject],
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Potential Matches</CardTitle>
            <CardDescription>
              Events that almost matched but scored below threshold
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <LoadingButton
              variant="outline"
              size="sm"
              onClick={onRefresh}
              loading={isLoading}
              icon={RefreshCw}
              iconClassName="w-4 h-4 mr-1"
            >
              Refresh
            </LoadingButton>
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <Button
            variant={filter === "pending" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("pending")}
          >
            Pending ({pendingCount})
          </Button>
          <Button
            variant={filter === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter("all")}
          >
            All ({nearMatches.length})
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : filteredMatches.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            {filter === "pending"
              ? "No pending near-matches to review"
              : "No near-matches detected yet"}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredMatches.map((nm) => (
              <NearMatchCard
                key={nm.id}
                nearMatch={nm}
                isExpanded={expandedId === nm.id}
                onToggleExpand={() =>
                  setExpandedId(expandedId === nm.id ? null : nm.id)
                }
                onConfirm={() => handleConfirm(nm.id)}
                onReject={() => handleReject(nm.id)}
                isProcessing={processingId === nm.id}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================
// Near-Match Card
// ============================================

interface NearMatchCardProps {
  nearMatch: NearMatch;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onConfirm: () => void;
  onReject: () => void;
  isProcessing: boolean;
}

function NearMatchCard({
  nearMatch,
  isExpanded,
  onToggleExpand,
  onConfirm,
  onReject,
  isProcessing,
}: NearMatchCardProps) {
  const { eventA, eventB, breakdown, failureReasons, status } = nearMatch;
  const scorePercent = Math.round(breakdown.finalScore * 100);

  const getScoreColor = (score: number) => {
    if (score >= 0.8) return "text-green-600 dark:text-green-400";
    if (score >= 0.6) return "text-yellow-600 dark:text-yellow-400";
    return "text-red-600 dark:text-red-400";
  };

  return (
    <div className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 space-y-2">
          {/* Event A */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs shrink-0">
              {eventA.provider}
            </Badge>
            <span className="font-medium">
              {eventA.homeTeam} vs {eventA.awayTeam}
            </span>
            <span className="text-xs text-muted-foreground">
              {eventA.competition}
            </span>
          </div>

          {/* Event B */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs shrink-0">
              {eventB.provider}
            </Badge>
            <span className="font-medium">
              {eventB.homeTeam} vs {eventB.awayTeam}
            </span>
            <span className="text-xs text-muted-foreground">
              {eventB.competition}
            </span>
          </div>

          {/* Score Summary */}
          <div className="flex items-center gap-4 text-xs mt-2">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Score:</span>
              <span
                className={`font-bold ${getScoreColor(breakdown.finalScore)}`}
              >
                {scorePercent}%
              </span>
              <Progress value={scorePercent} className="w-20 h-2" />
            </div>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Teams:</span>
              <span className={getScoreColor(breakdown.teamScore)}>
                {Math.round(breakdown.teamScore * 100)}%
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground">Comp:</span>
              <span className={getScoreColor(breakdown.competitionScore)}>
                {Math.round(breakdown.competitionScore * 100)}%
              </span>
            </div>
            {breakdown.timeDiffMs > 0 && (
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Time diff:</span>
                <span>{Math.round(breakdown.timeDiffMs / 60000)}m</span>
              </div>
            )}
          </div>

          {/* Failure Reasons */}
          <div className="flex flex-wrap gap-1 mt-1">
            {failureReasons.map((reason, idx) => (
              <Badge key={idx} variant="secondary" className="text-xs">
                <AlertTriangle className="w-3 h-3 mr-1" />
                {reason.type.replace(/_/g, " ")}
              </Badge>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 shrink-0">
          {status === "pending" ? (
            <>
              <Button
                size="sm"
                variant="default"
                onClick={onConfirm}
                disabled={isProcessing}
                className="bg-green-600 hover:bg-green-700"
              >
                <Check className="w-4 h-4 mr-1" />
                Confirm
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onReject}
                disabled={isProcessing}
              >
                <X className="w-4 h-4 mr-1" />
                Not Same
              </Button>
            </>
          ) : (
            <Badge
              variant={status === "confirmed" ? "default" : "secondary"}
              className={status === "confirmed" ? "bg-green-600" : ""}
            >
              {status}
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggleExpand}
            className="mt-1"
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="mt-4 pt-4 border-t space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-medium mb-1">Team Similarities</p>
              <p>
                Home vs Home:{" "}
                <span className={getScoreColor(breakdown.homeHomeSimilarity)}>
                  {Math.round(breakdown.homeHomeSimilarity * 100)}%
                </span>
              </p>
              <p>
                Away vs Away:{" "}
                <span className={getScoreColor(breakdown.awayAwaySimilarity)}>
                  {Math.round(breakdown.awayAwaySimilarity * 100)}%
                </span>
              </p>
              <p>
                Home vs Away (swapped):{" "}
                <span className={getScoreColor(breakdown.homeAwaySimilarity)}>
                  {Math.round(breakdown.homeAwaySimilarity * 100)}%
                </span>
              </p>
              <p>
                Away vs Home (swapped):{" "}
                <span className={getScoreColor(breakdown.awayHomeSimilarity)}>
                  {Math.round(breakdown.awayHomeSimilarity * 100)}%
                </span>
              </p>
              <p className="mt-1">
                Best orientation:{" "}
                <Badge variant="outline">{breakdown.bestOrientation}</Badge>
              </p>
            </div>
            <div>
              <p className="font-medium mb-1">Competitions</p>
              <p className="text-muted-foreground">{breakdown.competitionA}</p>
              <p className="text-muted-foreground">{breakdown.competitionB}</p>
              <p className="mt-1">
                Similarity:{" "}
                <span className={getScoreColor(breakdown.competitionScore)}>
                  {Math.round(breakdown.competitionScore * 100)}%
                </span>
              </p>
            </div>
          </div>
          <div className="pt-2">
            <p className="font-medium mb-1">Score Calculation</p>
            <p className="text-muted-foreground font-mono">
              0.6 × {Math.round(breakdown.teamScore * 100)}% + 0.2 ×{" "}
              {Math.round(breakdown.competitionScore * 100)}% + 0.2 ×{" "}
              {Math.round(breakdown.timeScore * 100)}% ={" "}
              <span
                className={`font-bold ${getScoreColor(breakdown.finalScore)}`}
              >
                {scorePercent}%
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default NearMatchesPanel;
