import {
  seedProvidersIfEmpty,
  getAllProviders,
} from "@/lib/db/repositories/ai-provider-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
  const deepseekHealthy = Boolean(process.env.DEEPSEEK_API_KEY);
  const geminiHealthy = Boolean(process.env.GEMINI_API_KEY);

  await seedProvidersIfEmpty();

  const allProviders = await getAllProviders();

  const providerMap = new Map(allProviders.map((p) => [p.name, p]));

  const deepseekFlash = providerMap.get("deepseek-flash");
  const deepseekPro = providerMap.get("deepseek-pro");
  const geminiLite = providerMap.get("gemini-lite");
  const geminiFlash = providerMap.get("gemini-flash");
  const geminiPro = providerMap.get("gemini-pro");

  const providers: Record<string, Record<string, unknown>> = {};

  const deepseekEnabled =
    deepseekFlash?.enabled ?? deepseekPro?.enabled ?? true;
  providers["deepseek"] = {
    model: deepseekModel,
    healthy: deepseekHealthy,
    disabled: !deepseekEnabled,
    manual_disabled: !deepseekEnabled,
    disabled_reason:
      deepseekFlash?.disabledReason ?? deepseekPro?.disabledReason ?? null,
    is_exhausted: !deepseekHealthy,
    monthlyUsage: deepseekFlash?.monthlyUsageCount ?? 0,
    monthlyLimit: deepseekFlash?.monthlyLimit ?? null,
  };

  if (geminiHealthy) {
    const gemini = geminiLite ?? geminiFlash ?? geminiPro;
    const geminiEnabled = gemini?.enabled ?? false;
    providers["gemini"] = {
      model: process.env.GEMINI_FLASH_MODEL || "gemini-3-flash",
      healthy: true,
      disabled: !geminiEnabled,
      manual_disabled: !geminiEnabled,
      disabled_reason: gemini?.disabledReason ?? null,
      is_exhausted: false,
      monthlyUsage: gemini?.monthlyUsageCount ?? 0,
      monthlyLimit: gemini?.monthlyLimit ?? null,
    };
  }

  const deepseekAllEnabled =
    (deepseekFlash?.enabled ?? deepseekPro?.enabled ?? true) && deepseekHealthy;
  const geminiAnyEnabled =
    (geminiLite?.enabled ??
      geminiFlash?.enabled ??
      geminiPro?.enabled ??
      false) &&
    geminiHealthy;

  const activeEngine = deepseekAllEnabled
    ? "deepseek"
    : geminiAnyEnabled
      ? "gemini"
      : "none";

  return Response.json({
    model: deepseekModel,
    usage: {
      active_engine: activeEngine,
      providers,
    },
    allProviders: allProviders.map((p) => ({
      name: p.name,
      enabled: p.enabled,
      engineType: p.engineType,
      monthlyUsage: p.monthlyUsageCount,
      monthlyLimit: p.monthlyLimit,
      monthlyRemaining: p.monthlyRemaining,
    })),
  });
}
