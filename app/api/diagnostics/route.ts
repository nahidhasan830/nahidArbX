/**
 * Diagnostics API
 *
 * Endpoints for near-match management and alias operations.
 */

import { NextResponse } from "next/server";
import {
  getNearMatches,
  getNearMatchById,
  getDiagnosticStats,
  pruneOldNearMatches,
} from "@/lib/matching/diagnostics";
import { generateDiagnosticReport } from "@/lib/matching/diagnostics/reports";
import {
  confirmNearMatch,
  rejectNearMatch,
} from "@/lib/matching/aliases/learner";
import {
  getAllTeamAliases,
  getAllCompetitionAliases,
  addTeamAlias,
  addCompetitionAlias,
  removeTeamAlias,
  removeCompetitionAlias,
  getAliasStats,
} from "@/lib/matching/aliases/store";
import {
  getMatchedEventsForVerification,
  unmatchEventCompletely,
} from "@/lib/store";
import {
  getSuspiciousStore,
  saveSuspiciousStore,
  type SuspiciousLevel,
} from "@/lib/matching/diagnostics/suspicious-store";

// ============================================
// GET - Fetch diagnostics data
// ============================================

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") || "summary";

  try {
    switch (view) {
      case "summary": {
        // Prune old near-matches first
        pruneOldNearMatches();

        const stats = getDiagnosticStats();
        const report = generateDiagnosticReport();
        const aliasStats = getAliasStats();

        return NextResponse.json({
          stats,
          report,
          aliasStats,
        });
      }

      case "near-matches": {
        const status = url.searchParams.get("status") as
          | "pending"
          | "confirmed"
          | "rejected"
          | undefined;
        const minScore = url.searchParams.get("minScore");
        const provider = url.searchParams.get("provider") || undefined;

        const nearMatches = getNearMatches({
          status,
          minScore: minScore ? parseFloat(minScore) : undefined,
          provider,
        });

        return NextResponse.json({
          nearMatches,
          count: nearMatches.length,
        });
      }

      case "near-match": {
        const id = url.searchParams.get("id");
        if (!id) {
          return NextResponse.json(
            { error: "Missing id parameter" },
            { status: 400 },
          );
        }

        const nearMatch = getNearMatchById(id);
        if (!nearMatch) {
          return NextResponse.json(
            { error: "Near-match not found" },
            { status: 404 },
          );
        }

        return NextResponse.json({ nearMatch });
      }

      case "aliases": {
        return NextResponse.json({
          teamAliases: getAllTeamAliases(),
          competitionAliases: getAllCompetitionAliases(),
          stats: getAliasStats(),
        });
      }

      case "report": {
        const report = generateDiagnosticReport();
        return NextResponse.json({ report });
      }

      case "matched-events": {
        // Get matched events for verification
        const limitStr = url.searchParams.get("limit");
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        const matchedEvents = getMatchedEventsForVerification({ limit });

        // Transform to the format expected by the learner
        const formatted = matchedEvents.map((event) => ({
          id: event.id,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          competition: event.competition,
          startTime: event.startTime,
          providers: Object.entries(event.providers).map(
            ([provider, data]) => ({
              provider,
              providerId: data?.eventId || "",
            }),
          ),
        }));

        return NextResponse.json({
          matchedEvents: formatted,
          count: formatted.length,
        });
      }

      case "suspicious": {
        // Get suspicious matches
        const suspiciousStore = getSuspiciousStore();
        const levelParam = url.searchParams.get(
          "level",
        ) as SuspiciousLevel | null;
        const statusParam = url.searchParams.get("status") as
          | "pending"
          | "confirmed_correct"
          | "unmatched"
          | undefined;
        const limitStr = url.searchParams.get("limit");
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        const suspicious = suspiciousStore.listSuspicious({
          level: levelParam || undefined,
          status: statusParam,
          limit,
        });

        const stats = suspiciousStore.getStats();
        const negativeExamples = suspiciousStore.getNegativeExamples();

        return NextResponse.json({
          suspicious,
          stats,
          negativeExamples,
          count: suspicious.length,
        });
      }

      default:
        return NextResponse.json(
          { error: `Invalid view: ${view}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("Diagnostics GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

// ============================================
// POST - Actions
// ============================================

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case "confirm-match": {
        const { nearMatchId, userId } = body;
        if (!nearMatchId) {
          return NextResponse.json(
            { error: "Missing nearMatchId" },
            { status: 400 },
          );
        }

        const learned = confirmNearMatch(nearMatchId, userId);
        if (!learned) {
          return NextResponse.json(
            { error: "Near-match not found or already processed" },
            { status: 404 },
          );
        }

        return NextResponse.json({
          success: true,
          learned,
          message: `Confirmed match. Learned ${learned.teamAliases.length} team aliases, ${learned.competitionAliases.length} competition aliases.`,
        });
      }

      case "reject-match": {
        const { nearMatchId, userId } = body;
        if (!nearMatchId) {
          return NextResponse.json(
            { error: "Missing nearMatchId" },
            { status: 400 },
          );
        }

        const success = rejectNearMatch(nearMatchId, userId);
        if (!success) {
          return NextResponse.json(
            { error: "Near-match not found" },
            { status: 404 },
          );
        }

        return NextResponse.json({ success: true });
      }

      case "add-team-alias": {
        const { source, canonical, userId } = body;
        if (!source || !canonical) {
          return NextResponse.json(
            { error: "Missing source or canonical" },
            { status: 400 },
          );
        }

        addTeamAlias(source, canonical, {
          autoLearned: false,
          addedBy: userId,
        });

        return NextResponse.json({
          success: true,
          message: `Added team alias: "${source}" -> "${canonical}"`,
        });
      }

      case "add-competition-alias": {
        const { source, canonical, userId } = body;
        if (!source || !canonical) {
          return NextResponse.json(
            { error: "Missing source or canonical" },
            { status: 400 },
          );
        }

        addCompetitionAlias(source, canonical, {
          autoLearned: false,
          addedBy: userId,
        });

        return NextResponse.json({
          success: true,
          message: `Added competition alias: "${source}" -> "${canonical}"`,
        });
      }

      case "remove-team-alias": {
        const { source } = body;
        if (!source) {
          return NextResponse.json(
            { error: "Missing source" },
            { status: 400 },
          );
        }

        const success = removeTeamAlias(source);
        return NextResponse.json({
          success,
          message: success
            ? `Removed team alias: "${source}"`
            : `Team alias not found: "${source}"`,
        });
      }

      case "remove-competition-alias": {
        const { source } = body;
        if (!source) {
          return NextResponse.json(
            { error: "Missing source" },
            { status: 400 },
          );
        }

        const success = removeCompetitionAlias(source);
        return NextResponse.json({
          success,
          message: success
            ? `Removed competition alias: "${source}"`
            : `Competition alias not found: "${source}"`,
        });
      }

      case "prune": {
        const { maxAgeMs } = body;
        const removed = pruneOldNearMatches(maxAgeMs);
        return NextResponse.json({
          success: true,
          removed,
          message: `Pruned ${removed} old near-matches`,
        });
      }

      // ============================================
      // Phase 3: Unmatch & Suspicious Actions
      // ============================================

      case "unmatch": {
        const { eventId } = body;
        if (!eventId) {
          return NextResponse.json(
            { error: "Missing eventId" },
            { status: 400 },
          );
        }

        const result = unmatchEventCompletely(eventId);
        if (!result.success) {
          return NextResponse.json({ error: result.message }, { status: 400 });
        }

        return NextResponse.json({
          success: true,
          message: result.message,
          separatedEvents: result.separatedEvents?.map((e) => e.id) || [],
        });
      }

      case "confirm-suspicious-correct": {
        // Mark a suspicious match as actually correct
        const { suspiciousId, userId } = body;
        if (!suspiciousId) {
          return NextResponse.json(
            { error: "Missing suspiciousId" },
            { status: 400 },
          );
        }

        const suspiciousStore = getSuspiciousStore();
        const result = suspiciousStore.confirmCorrect(
          suspiciousId,
          userId || "user",
        );
        saveSuspiciousStore();

        if (!result.success) {
          return NextResponse.json({ error: result.message }, { status: 400 });
        }

        return NextResponse.json({
          success: true,
          message: result.message,
        });
      }

      case "unmatch-suspicious": {
        // Confirm a suspicious match is wrong and unmatch it
        const { suspiciousId, userId } = body;
        if (!suspiciousId) {
          return NextResponse.json(
            { error: "Missing suspiciousId" },
            { status: 400 },
          );
        }

        const suspiciousStore = getSuspiciousStore();
        const suspicious = suspiciousStore.getSuspicious(suspiciousId);

        if (!suspicious) {
          return NextResponse.json(
            { error: "Suspicious match not found" },
            { status: 404 },
          );
        }

        // Mark as unmatched in suspicious store (adds negative example)
        const result = suspiciousStore.markUnmatched(
          suspiciousId,
          userId || "user",
        );
        saveSuspiciousStore();

        if (!result.success) {
          return NextResponse.json({ error: result.message }, { status: 400 });
        }

        // Actually unmatch the event
        const unmatchResult = unmatchEventCompletely(suspicious.matchedId);

        return NextResponse.json({
          success: true,
          message: result.message,
          negativeExampleId: result.negativeExampleId,
          unmatchResult: unmatchResult.success
            ? "Event unmatched"
            : "Event not found (may have already been unmatched)",
        });
      }

      case "add-suspicious": {
        // Manually flag an event as suspicious
        const {
          eventId,
          level,
          aiConfidence,
          aiReasoning,
          suspiciousElements,
          providerItems,
        } = body;

        if (!eventId) {
          return NextResponse.json(
            { error: "Missing eventId" },
            { status: 400 },
          );
        }

        const suspiciousStore = getSuspiciousStore();
        const suspicious = suspiciousStore.addSuspicious({
          level: level || "event",
          matchedId: eventId,
          providerItems: providerItems || [],
          originalScore: 1.0,
          aiConfidence: aiConfidence || 0,
          aiReasoning: aiReasoning || "Manually flagged",
          suspiciousElements: suspiciousElements || [
            "Manually flagged by user",
          ],
          detectedBy: "user-report",
        });
        saveSuspiciousStore();

        return NextResponse.json({
          success: true,
          suspicious,
          message: "Event flagged as suspicious",
        });
      }

      case "remove-suspicious": {
        const { suspiciousId } = body;
        if (!suspiciousId) {
          return NextResponse.json(
            { error: "Missing suspiciousId" },
            { status: 400 },
          );
        }

        const suspiciousStore = getSuspiciousStore();
        const success = suspiciousStore.removeSuspicious(suspiciousId);
        saveSuspiciousStore();

        return NextResponse.json({
          success,
          message: success
            ? "Suspicious match removed"
            : "Suspicious match not found",
        });
      }

      case "remove-negative-example": {
        const { negativeExampleId } = body;
        if (!negativeExampleId) {
          return NextResponse.json(
            { error: "Missing negativeExampleId" },
            { status: 400 },
          );
        }

        const suspiciousStore = getSuspiciousStore();
        const success =
          suspiciousStore.removeNegativeExample(negativeExampleId);
        saveSuspiciousStore();

        return NextResponse.json({
          success,
          message: success
            ? "Negative example removed"
            : "Negative example not found",
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (error) {
    console.error("Diagnostics POST error:", error);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }
}
