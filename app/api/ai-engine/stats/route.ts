import { logger } from "@/lib/shared/logger";
import { getSearchRouter } from "@/lib/ai/search/router";
import { seedProvidersIfEmpty, getAllProviders } from "@/lib/db/repositories/ai-provider-config";

export const dynamic = "force-dynamic";


export async function GET() {
  try {
    // Ensure providers are seeded
    await seedProvidersIfEmpty();

    // Get stats from search router (live session data)
    const stats = getSearchRouter().getStats();

    // Get actual quota data from DB
    const providers = await getAllProviders();

    return Response.json({
      providers: stats.providers,
      totalSearches: stats.totalSearches,
      allProviders: providers.map(p => ({
        name: p.name,
        enabled: p.enabled,
        engineType: p.engineType,
        label: p.label,
        monthlyUsage: p.monthlyUsageCount,
        monthlyLimit: p.monthlyLimit,
        monthlyRemaining: p.monthlyRemaining,
        isExhausted: p.isExhausted,
      })),
      llmEngine: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      llmHealthy: Boolean(process.env.DEEPSEEK_API_KEY),
      serviceOffline: false,
    });
  } catch (err) {
    logger.error("ai-engine-stats", String(err));
    return Response.json(
      {
        providers: [],
        totalSearches: 0,
        llmEngine: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        llmHealthy: false,
        serviceOffline: true,
        serviceError: String(err),
      },
      { status: 500 },
    );
  }
}