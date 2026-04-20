/**
 * System Cleanup API
 *
 * GET  - Get cleanup targets with sizes and recommendations
 * POST - Execute cleanup actions
 */

import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

import {
  clearHarvestStaging,
  getHarvestCandidates,
} from "@/lib/matching/aliases/harvester";
import { clearAllAliases, getAliasStats } from "@/lib/matching/aliases/store";
import { clearAllDecisions } from "@/lib/matching/ai-decision-cache";
import { resetMatchCache } from "@/lib/matching/match-cache";
import { clearSimilarityCache } from "@/lib/matching/similarity-cache";
import {
  pruneOldNearMatches,
  clearNearMatches,
  getNearMatches,
} from "@/lib/matching/diagnostics";

// ============================================
// Helpers
// ============================================

function getFileSize(filePath: string): number {
  try {
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================
// Data paths
// ============================================

const DATA_DIR = process.cwd();
const PATHS = {
  nearMatches: path.join(DATA_DIR, "rawData", "near-matches.json"),
  harvestStaging: path.join(
    DATA_DIR,
    "data",
    "aliases",
    "harvest-staging.json",
  ),
  aiDecisionCache: path.join(
    DATA_DIR,
    "data",
    "gemini",
    "ai-decision-cache.json",
  ),
  unmappedMarkets: path.join(
    DATA_DIR,
    "data",
    "aliases",
    "unmapped-markets.json",
  ),
};

// ============================================
// GET - Cleanup targets
// ============================================

export async function GET() {
  try {
    const targets = [
      {
        id: "near-matches",
        name: "Near-Match History",
        description: "Events that almost matched (70-85% similarity)",
        size: formatBytes(getFileSize(PATHS.nearMatches)),
        sizeBytes: getFileSize(PATHS.nearMatches),
        count: getNearMatches().length,
        recommended: getFileSize(PATHS.nearMatches) > 200 * 1024,
        severity:
          getFileSize(PATHS.nearMatches) > 500 * 1024 ? "high" : "medium",
      },
      {
        id: "harvest-staging",
        name: "Alias Harvest Staging",
        description: "Candidate aliases waiting for promotion threshold",
        size: formatBytes(getFileSize(PATHS.harvestStaging)),
        sizeBytes: getFileSize(PATHS.harvestStaging),
        count: getHarvestCandidates().length,
        recommended: false,
        severity: "low",
      },
      {
        id: "ai-decision-cache",
        name: "Gemini Decision Cache",
        description:
          "Cached Gemini/human verdicts per event pair. Clearing re-surfaces all decided pairs and re-burns API quota on previously analyzed pairs.",
        size: formatBytes(getFileSize(PATHS.aiDecisionCache)),
        sizeBytes: getFileSize(PATHS.aiDecisionCache),
        recommended: false,
        severity: "low",
      },
      (() => {
        const stats = getAliasStats();
        const totalAliases = stats.teamAliases + stats.competitionAliases;
        return {
          id: "learned-aliases",
          name: "Learned Aliases (teams + competitions)",
          description:
            "All learned team and competition name mappings. Wipes both the files AND the in-memory store so you start from a clean slate. Expect lower match rates until aliases re-accumulate from new approvals.",
          size: formatBytes(
            getFileSize(
              path.join(DATA_DIR, "data", "aliases", "team-aliases.json"),
            ) +
              getFileSize(
                path.join(
                  DATA_DIR,
                  "data",
                  "aliases",
                  "competition-aliases.json",
                ),
              ),
          ),
          sizeBytes:
            getFileSize(
              path.join(DATA_DIR, "data", "aliases", "team-aliases.json"),
            ) +
            getFileSize(
              path.join(
                DATA_DIR,
                "data",
                "aliases",
                "competition-aliases.json",
              ),
            ),
          count: totalAliases,
          recommended: false,
          severity: "high" as const,
        };
      })(),
      {
        id: "unmapped-markets",
        name: "Unmapped Markets Log",
        description: "Markets that couldn't be matched to atoms",
        size: formatBytes(getFileSize(PATHS.unmappedMarkets)),
        sizeBytes: getFileSize(PATHS.unmappedMarkets),
        recommended: getFileSize(PATHS.unmappedMarkets) > 200 * 1024,
        severity:
          getFileSize(PATHS.unmappedMarkets) > 300 * 1024 ? "high" : "medium",
      },
      {
        id: "match-cache",
        name: "Match Cache (memory)",
        description: "In-memory event match cache. Resets on restart.",
        size: "in-memory",
        sizeBytes: 0,
        recommended: false,
        severity: "low",
      },
      {
        id: "similarity-cache",
        name: "Similarity Cache (memory)",
        description:
          "In-memory string similarity LRU cache. Resets on restart.",
        size: "in-memory",
        sizeBytes: 0,
        recommended: false,
        severity: "low",
      },
    ];

    const totalSize = targets.reduce((sum, t) => sum + t.sizeBytes, 0);
    const recommendedCount = targets.filter((t) => t.recommended).length;

    return NextResponse.json({
      targets,
      summary: {
        totalSize: formatBytes(totalSize),
        totalSizeBytes: totalSize,
        recommendedCleanups: recommendedCount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

// ============================================
// POST - Execute cleanup
// ============================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { targets } = body as { targets: string[] };

    if (!targets || !Array.isArray(targets)) {
      return NextResponse.json(
        { error: "targets array required" },
        { status: 400 },
      );
    }

    const results: Array<{
      id: string;
      success: boolean;
      freed?: string;
      error?: string;
    }> = [];

    for (const targetId of targets) {
      try {
        switch (targetId) {
          case "near-matches": {
            const sizeBefore = getFileSize(PATHS.nearMatches);
            pruneOldNearMatches();
            clearNearMatches();
            const freed = sizeBefore - getFileSize(PATHS.nearMatches);
            results.push({
              id: targetId,
              success: true,
              freed: formatBytes(Math.max(0, freed)),
            });
            break;
          }

          case "harvest-staging": {
            clearHarvestStaging();
            results.push({ id: targetId, success: true, freed: "cleared" });
            break;
          }

          case "ai-decision-cache": {
            const fp = PATHS.aiDecisionCache;
            const freed = getFileSize(fp);
            // Wipe in-memory store AND the file. The cache keeps data on
            // globalThis to survive hot reloads; deleting only the file would
            // let the next save re-write the surviving data.
            clearAllDecisions();
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
            results.push({
              id: targetId,
              success: true,
              freed: formatBytes(freed),
            });
            break;
          }

          case "learned-aliases": {
            const removed = clearAllAliases();
            resetMatchCache();
            results.push({
              id: targetId,
              success: true,
              freed: `${removed.team + removed.competition} aliases cleared`,
            });
            break;
          }

          case "unmapped-markets": {
            if (fs.existsSync(PATHS.unmappedMarkets)) {
              const freed = fs.statSync(PATHS.unmappedMarkets).size;
              fs.writeFileSync(
                PATHS.unmappedMarkets,
                JSON.stringify({ markets: [] }, null, 2),
              );
              results.push({
                id: targetId,
                success: true,
                freed: formatBytes(freed),
              });
            } else {
              results.push({ id: targetId, success: true, freed: "0 B" });
            }
            break;
          }

          case "match-cache": {
            resetMatchCache();
            results.push({ id: targetId, success: true, freed: "reset" });
            break;
          }

          case "similarity-cache": {
            clearSimilarityCache();
            results.push({ id: targetId, success: true, freed: "reset" });
            break;
          }

          default:
            results.push({
              id: targetId,
              success: false,
              error: "Unknown target",
            });
        }
      } catch (error) {
        results.push({
          id: targetId,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
