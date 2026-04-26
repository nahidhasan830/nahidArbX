/**
 * Aggregate health snapshot consumed by the legacy EntityInspector
 * Overview panel.
 *
 * NOTE: this route is on its way out — the new MatcherPanel uses
 * `/api/entities/inbox`, `/api/entities/recent-decisions`, and
 * `/api/entities/calibration` instead. This file stays compile-clean
 * during the rebuild so the deleted scheduler / resolver-runs
 * dependencies are gone, but the consumer panel is being replaced in
 * Phase 6/7 and this route will be deleted alongside it.
 */

import { NextResponse } from "next/server";
import {
  getEntityStats,
  observationsBySource,
  observationsTimeline,
} from "@/lib/db/repositories/entities";

export async function GET() {
  const [stats, timeline, bySource] = await Promise.all([
    getEntityStats(),
    observationsTimeline(24),
    observationsBySource(24),
  ]);
  return NextResponse.json({
    stats,
    observationsTimeline: timeline,
    observationsBySource: bySource,
    classifierHistogram: [],
    activeRun: null,
    scheduler: null,
  });
}
