import { logger } from "@/lib/shared/logger";
import { getSearchRouter } from "@/lib/ai/search/router";

const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const llmHealthy = Boolean(apiKey);
    const stats = getSearchRouter().getStats();
    const healthy = stats.providers.filter((p) => p.healthy).length;

    return Response.json({
      status: llmHealthy && healthy > 0 ? "ok" : "degraded",
      llmEngine: {
        active: "deepseek",
        model: DEEPSEEK_MODEL,
        healthy: llmHealthy,
      },
      searchProviders: {
        total: stats.providers.length,
        healthy,
      },
    });
  } catch (err) {
    logger.error("ai-engine-healthz", String(err));
    return Response.json(
      { status: "offline", error: String(err) },
      { status: 500 },
    );
  }
}
