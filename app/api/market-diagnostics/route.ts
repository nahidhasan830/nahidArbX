import { NextResponse, type NextRequest } from "next/server";
import {
  getTopUnmappedMarkets,
  getRecentAnomalies,
  getAnomalyStats,
  getUnmappedProviders,
} from "@/lib/db/repositories/market-diagnostics";
import {
  getAllOddsForAtom,
  getFamiliesForEvent,
  getAllEventIds,
  getStoreStats,
  getMatchedMarketsCount,
} from "@/lib/atoms/store";
import { getFamily } from "@/lib/atoms/registry";
import { getMatchedEvents, getEvent } from "@/lib/store";
import {
  getEnabledProviderIds,
  getProviderShortName,
  isSharpProvider,
  type ProviderKey,
} from "@/lib/providers/registry";
import { ANOMALY_IP_DEVIATION_THRESHOLD } from "@/lib/shared/constants";

/**
 * Basic lexical normalizer for clustering unmapped markets
 */
function normalizeMarketName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ") // replace punctuation with space
    .replace(/\b(the|a|an|team|match|1|2|1x2|over|under)\b/g, "") // remove common stop words
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * GET /api/market-diagnostics
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const tab = searchParams.get("tab") ?? "discovery";
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 1000);

  try {
    switch (tab) {
      // ─── ML Discovery Engine (Lexical Clustering Mock) ────────
      case "discovery": {
        let unmapped = [];
        try {
          unmapped = await getTopUnmappedMarkets(2000);
        } catch {
          // Table might not exist yet
          return NextResponse.json({ clusters: [] });
        }

        // Group by normalized name
        const clustersMap = new Map<string, {
          id: string;
          clusterName: string;
          totalOccurrences: number;
          providers: Set<string>;
          markets: unknown[];
        }>();
        
        for (const u of unmapped) {
          const normName = normalizeMarketName(u.rawMarketName || u.rawMarketKey);
          if (!normName) continue;
          
          if (!clustersMap.has(normName)) {
            clustersMap.set(normName, {
              id: `cluster-${normName.replace(/\s/g, "-")}`,
              clusterName: normName,
              totalOccurrences: 0,
              providers: new Set<string>(),
              markets: [],
            });
          }
          
          const cluster = clustersMap.get(normName)!;
          cluster.totalOccurrences += (u.occurrenceCount || 1);
          cluster.providers.add(u.provider);
          
          // Mocking LightGBM prediction randomly for demonstration of the UI
          const mockPrediction = Math.random() > 0.7 ? {
             targetAtom: ["home_total", "asian_handicap", "btts"][Math.floor(Math.random() * 3)],
             probability: 0.7 + (Math.random() * 0.25)
          } : undefined;

          cluster.markets.push({
            provider: u.provider,
            marketKey: u.rawMarketKey,
            marketName: u.rawMarketName || u.rawMarketKey,
            occurrenceCount: u.occurrenceCount,
            samplePayload: u.samplePayload,
            prediction: mockPrediction
          });
        }

        // Filter and map to final array
        const clusters = Array.from(clustersMap.values())
          .map(c => ({
            ...c,
            providersCount: c.providers.size,
            providers: undefined, // remove Set before JSON serialization
          }))
          // Only show clusters that span multiple providers, or have high occurrence
          .filter(c => c.providersCount > 1 || c.totalOccurrences > 50)
          .sort((a, b) => b.totalOccurrences - a.totalOccurrences)
          .slice(0, 50);

        return NextResponse.json({ clusters });
      }

      // ─── Anomaly X-Ray ─────────────────────────────────────────────
      case "anomalies": {
        try {
          const anomalies = await getRecentAnomalies(limit);
          const rows = anomalies.map(a => ({
             id: `anomaly-${a.id}`,
             eventId: a.eventId,
             familyId: a.familyId,
             atomId: a.atomId,
             softProvider: a.softProvider,
             sharpProvider: a.sharpProvider,
             softOdds: (a as any).softOdds,
             sharpOdds: (a as any).sharpOdds,
             ipSoft: a.ipSoft,
             ipSharp: a.ipSharp,
             deviationPct: a.deviationPct,
             anomalyType: a.anomalyType,
             timestamp: String(a.createdAt),
          }));
          return NextResponse.json({ rows });
        } catch (e) {
          console.error("Anomalies fetch error:", e);
          return NextResponse.json({ rows: [] });
        }
      }

      // ─── Existing Health/Stats ─────────────────────────────────────
      case "health": {
        const storeStats = getStoreStats();
        const matchedCount = getMatchedMarketsCount();
        const activeEvents = getAllEventIds().length;

        let unmappedTotal = 0;
        let anomalyTotal = 0;
        let reversalCount = 0;
        let anomalyByType: Array<{ anomalyType: string; count: number; avgDeviation: number }> = [];

        try {
          const anomalyStats = await getAnomalyStats();
          anomalyTotal = anomalyStats.total;
          anomalyByType = anomalyStats.byType;
          reversalCount = anomalyStats.byType.find(
            (t) => t.anomalyType === "participant_reversal",
          )?.count ?? 0;
        } catch { /* ignore */ }

        try {
          const unmappedRows = await getTopUnmappedMarkets(10000);
          unmappedTotal = unmappedRows.length;
        } catch { /* ignore */ }

        return NextResponse.json({
          matchedMarkets: matchedCount,
          totalAtoms: storeStats.totalAtoms,
          totalOddsRecords: storeStats.totalOddsRecords,
          activeEvents,
          unmappedCount: unmappedTotal,
          anomalyTotal,
          reversalCount,
          anomalyByType,
        });
      }

      case "providers": {
        try {
          const providers = await getUnmappedProviders();
          return NextResponse.json({ providers });
        } catch {
          return NextResponse.json({ providers: [] });
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown tab: ${tab}` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
