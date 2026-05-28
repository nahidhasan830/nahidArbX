/**
 * Matcher Lab API
 *
 * GET  ?stage=inbox|human_review|history  — list pairs by stage
 *      &limit=N &offset=N                          — pagination
 *
 * POST action=decide   { id, decision, decidedBy, reason? }
 *      action=run-ml   {}                          — trigger ML batch on the ML server
 *      action=bulk-decide { items: [{id, decision}], decidedBy }
 *      action=update-scheduler { enabled?, intervalMs? } — write config to Postgres
 */

import { NextRequest, NextResponse } from "next/server";
import {
  listByStage,
  getById,
  markDecided,
  type MatchPairStage,
  type MatchPairDecision,
  type MatchPairDecidedBy,
} from "@/lib/db/repositories/match-pairs";
import { db } from "@/lib/db/client";
import { matcherConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getIdToken } from "@/lib/matching/entities/matcher-client";
import { learnAliasesForMatchPair } from "@/lib/matching/matcher-lab-aliases";
import { resolveMatcherRunWithAiSearch } from "@/lib/matching/matcher-lab-ai-resolver";
import { logger } from "@/lib/shared/logger";

const tag = "MatcherLab";

const VALID_STAGES: MatchPairStage[] = ["inbox", "human_review", "history"];

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const stage = url.searchParams.get("stage") ?? "human_review";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const offset = Number(url.searchParams.get("offset")) || 0;

    if (!VALID_STAGES.includes(stage as MatchPairStage)) {
      return NextResponse.json(
        { error: `Invalid stage: ${stage}` },
        { status: 400 },
      );
    }

    const rows = await listByStage(stage as MatchPairStage, { limit, offset });

    return NextResponse.json({ rows, stage, limit, offset });
  } catch (err) {
    logger.error(tag, `GET failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case "decide": {
        const { id, decision, decidedBy, reason } = body as {
          id: string;
          decision: MatchPairDecision;
          decidedBy: MatchPairDecidedBy;
          reason?: string;
        };

        if (!id || !decision || !decidedBy) {
          return NextResponse.json(
            { error: "id, decision, and decidedBy are required" },
            { status: 400 },
          );
        }

        const ok = await markDecided(id, decision, decidedBy, reason);
        if (!ok) {
          return NextResponse.json(
            { error: "Pair not found" },
            { status: 404 },
          );
        }

        if (decision === "human-merge" || decision === "ai-merge") {
          const pair = await getById(id);
          if (pair) {
            await learnAliasesForMatchPair(pair);
          }
        }

        logger.info(tag, `Decided ${id}: ${decision} by ${decidedBy}`);

        return NextResponse.json({ success: true });
      }

      case "bulk-decide": {
        const { items, decidedBy } = body as {
          items: { id: string; decision: MatchPairDecision; reason?: string }[];
          decidedBy: MatchPairDecidedBy;
        };

        if (!items?.length || !decidedBy) {
          return NextResponse.json(
            { error: "items[] and decidedBy required" },
            { status: 400 },
          );
        }

        let succeeded = 0;
        let failed = 0;

        for (const item of items) {
          const ok = await markDecided(
            item.id,
            item.decision,
            decidedBy,
            item.reason,
          );
          if (ok) {
            succeeded++;
            if (
              item.decision === "human-merge" ||
              item.decision === "ai-merge"
            ) {
              const pair = await getById(item.id);
              if (pair) {
                await learnAliasesForMatchPair(pair);
              }
            }
          } else {
            failed++;
          }
        }

        logger.info(tag, `Bulk decide: ${succeeded} ok, ${failed} failed`);

        return NextResponse.json({ succeeded, failed });
      }

      case "run-ml": {
        const matcherUrl = process.env.ENTITY_MATCHER_URL;
        if (!matcherUrl) {
          return NextResponse.json(
            { error: "ENTITY_MATCHER_URL not configured" },
            { status: 503 },
          );
        }

        try {
          const token = await getIdToken();
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (token) headers.Authorization = `Bearer ${token}`;

          const res = await fetch(
            `${matcherUrl.replace(/\/$/, "")}/scheduler/run-now`,
            { method: "POST", headers },
          );
          if (!res.ok) {
            const txt = await res.text().catch(() => "");
            return NextResponse.json(
              { error: `ML server returned ${res.status}: ${txt}` },
              { status: 502 },
            );
          }
          const result = await resolveMatcherRunWithAiSearch(await res.json());
          logger.info(
            tag,
            `ML batch (via server): ${result.processed} processed, ${result.merged} merged, ${result.rejected} rejected, ${result.escalated} escalated, AI Search ${result.aiSearchMerged ?? 0}m/${result.aiSearchRejected ?? 0}r`,
          );
          return NextResponse.json(result);
        } catch (err) {
          logger.error(tag, `ML server unreachable: ${(err as Error).message}`);
          return NextResponse.json(
            { error: `ML server unreachable: ${(err as Error).message}` },
            { status: 503 },
          );
        }
      }

      case "update-scheduler": {
        const {
          enabled,
          intervalMs,
          aiSearchEnabled,
          aiSearchConfidenceThreshold,
          aiSearchMaxBatchSize,
        } = body as {
          enabled?: boolean;
          intervalMs?: number;
          aiSearchEnabled?: boolean;
          aiSearchConfidenceThreshold?: number;
          aiSearchMaxBatchSize?: number;
        };

        const updates: Partial<typeof matcherConfig.$inferInsert> = {};

        if (typeof enabled === "boolean") {
          updates.enabled = enabled;
        }
        if (typeof intervalMs === "number") {
          updates.intervalMs = Math.max(10_000, Math.min(600_000, intervalMs));
        }
        if (typeof aiSearchEnabled === "boolean") {
          updates.aiSearchEnabled = aiSearchEnabled;
        }
        if (typeof aiSearchConfidenceThreshold === "number") {
          updates.aiSearchConfidenceThreshold = Math.max(
            0,
            Math.min(100, Math.round(aiSearchConfidenceThreshold)),
          );
        }
        if (typeof aiSearchMaxBatchSize === "number") {
          updates.aiSearchMaxBatchSize = Math.max(
            1,
            Math.min(20, Math.round(aiSearchMaxBatchSize)),
          );
        }

        if (Object.keys(updates).length > 0) {
          await db
            .update(matcherConfig)
            .set({ ...updates, updatedAt: new Date().toISOString() })
            .where(eq(matcherConfig.id, "default"));
        }

        logger.info(
          tag,
          `Config updated: enabled=${enabled}, intervalMs=${intervalMs}, aiSearch=${aiSearchEnabled}`,
        );

        return NextResponse.json({ success: true });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    logger.error(tag, `POST failed: ${(err as Error).message}`);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
