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
  ensureCompetitionEntity,
  ensureTeamEntity,
  recordObservation,
} from "@/lib/matching/entities";
import {
  getEntityStats,
  listEntities,
  getEntityNamesForEntity,
  setEntityNameStatus,
} from "@/lib/db/repositories/entities";
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
        const entityStats = await getEntityStats();
        // Expose entity stats under both keys so older callers that still
        // expect aliasStats see something coherent during the cutover.
        const aliasStats = {
          teamAliases: entityStats.namesActive,
          competitionAliases: entityStats.entitiesActive,
          autoLearned: entityStats.namesActive,
          manual: 0,
        };

        return NextResponse.json({
          stats,
          report,
          aliasStats,
          entityStats,
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
        // Compatibility shim: returns flat lists of (source -> canonical)
        // pairs by walking active entity_names rows. The /api/entities
        // routes are the proper modern surface; this view just keeps the
        // legacy AliasManager reads from 500ing during the UI cutover.
        const teams = await listEntities({
          kind: "team",
          limit: 500,
        });
        const comps = await listEntities({
          kind: "competition",
          limit: 500,
        });
        const flatten = async (list: typeof teams) => {
          const out: Array<{
            source: string;
            canonical: string;
            addedAt: string;
            addedBy?: string;
            autoLearned: boolean;
            occurrences: number;
          }> = [];
          for (const ent of list) {
            const names = await getEntityNamesForEntity(ent.id);
            for (const n of names) {
              if (n.status !== "active") continue;
              if (
                n.surfaceRaw.toLowerCase() === ent.canonicalName.toLowerCase()
              )
                continue;
              out.push({
                source: n.surfaceRaw,
                canonical: ent.canonicalName,
                addedAt: n.firstSeenAt,
                addedBy: n.provider,
                autoLearned: n.provider !== "seed",
                occurrences: n.positiveObs,
              });
            }
          }
          return out;
        };
        const stats = await getEntityStats();
        return NextResponse.json({
          teamAliases: await flatten(teams),
          competitionAliases: await flatten(comps),
          stats: {
            teamAliases: stats.namesActive,
            competitionAliases: stats.entitiesActive,
            autoLearned: stats.namesActive,
            manual: 0,
          },
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

        const learned = await confirmNearMatch(nearMatchId, userId);
        if (!learned) {
          return NextResponse.json(
            { error: "Near-match not found or already processed" },
            { status: 404 },
          );
        }

        return NextResponse.json({
          success: true,
          learned,
          message: `Confirmed match. Recorded ${learned.teamAliases.length} team observations, ${learned.competitionAliases.length} competition observations.`,
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
        const teamEntity = await ensureTeamEntity({ canonicalName: canonical });
        if (!teamEntity) {
          return NextResponse.json(
            { error: "Failed to create canonical entity" },
            { status: 500 },
          );
        }
        await recordObservation({
          kind: "team",
          surface: source,
          provider: "manual",
          competitionId: null,
          pairedWithEntityId: teamEntity.id,
          matchScore: 1,
          outcome: "manual-confirm",
          source: "match-review",
          metadata: { addedBy: userId ?? "manual" },
        });
        return NextResponse.json({
          success: true,
          message: `Recorded team observation: "${source}" → "${canonical}"`,
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
        const compEntity = await ensureCompetitionEntity(canonical);
        if (!compEntity) {
          return NextResponse.json(
            { error: "Failed to create competition entity" },
            { status: 500 },
          );
        }
        await recordObservation({
          kind: "competition",
          surface: source,
          provider: "manual",
          competitionId: null,
          pairedWithEntityId: compEntity.id,
          matchScore: 1,
          outcome: "manual-confirm",
          source: "match-review",
          metadata: { addedBy: userId ?? "manual" },
        });
        return NextResponse.json({
          success: true,
          message: `Recorded competition observation: "${source}" → "${canonical}"`,
        });
      }

      // Removal in the entity model is per-name, not per-canonical. The
      // legacy "remove the source→canonical row" semantic doesn't map
      // cleanly; the EntityInspector UI exposes per-row retire instead.
      // For backwards compat, this finds any active entity_name row whose
      // surface_raw matches and retires that single row.
      case "remove-team-alias":
      case "remove-competition-alias": {
        const { source } = body;
        if (!source) {
          return NextResponse.json(
            { error: "Missing source" },
            { status: 400 },
          );
        }
        const wantedKind =
          action === "remove-team-alias" ? "team" : "competition";
        const all = await listEntities({ kind: wantedKind, limit: 1000 });
        let found = 0;
        for (const ent of all) {
          const names = await getEntityNamesForEntity(ent.id);
          for (const n of names) {
            if (
              n.status === "active" &&
              n.surfaceRaw.toLowerCase().trim() ===
                String(source).toLowerCase().trim()
            ) {
              await setEntityNameStatus(n.id, "retired");
              found++;
            }
          }
        }
        return NextResponse.json({
          success: found > 0,
          message:
            found > 0
              ? `Retired ${found} entity_name row(s) with surface "${source}"`
              : `No active entity_name found with surface "${source}"`,
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
