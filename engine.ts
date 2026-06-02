/**
 * Standalone Engine Entry Point
 *
 * Runs all background subsystems (sync, detection, settlement, WebSockets,
 * Telegram) as a separate Node.js process, decoupled from the Next.js
 * web server.
 *
 * Usage:
 *   node --import tsx engine.ts          (dev)
 *   node --import tsx engine.ts          (production, via PM2)
 *
 * Why separate:
 *   Next.js Turbopack dev server has a ~350MB heap memory watchdog that
 *   force-restarts the process. With 13 background subsystems sharing
 *   the same process, heap climbs past the threshold within 2 minutes,
 *   creating an infinite restart loop. Separating the engine means
 *   Next.js only compiles UI code (stays under 200MB), and the engine
 *   runs as a plain Node.js process with no memory watchdog.
 *
 * The engine shares the same `lib/` code as `instrumentation.ts`.
 * No business logic is duplicated — only the lifecycle differs.
 */

import "dotenv/config";

// Signal to instrumentation.ts that the engine is running separately.
// When Next.js sees this env var, it skips all background boot.
process.env.NAHIDARBX_ENGINE = "1";

async function main() {
  const { logger } = await import("./lib/shared/logger");

  logger.info("Engine", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info("Engine", "Starting standalone engine process...");
  logger.info("Engine", `PID: ${process.pid} | Node: ${process.version}`);
  logger.info("Engine", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── Initialize database pool ────────────────────────────────────────
  const { ensureDbReady } = await import("./lib/db/client");
  await ensureDbReady();
  logger.info("Boot", "Database pool initialized");

  // ── ML feature contract diagnostic ──────────────────────────────────
  const { FEATURE_VERSION, FEATURE_COUNT, FEATURE_NAMES_HASH } =
    await import("./lib/ml/feature-contract");
  logger.info(
    "Boot",
    `ML feature contract: FEATURE_VERSION=${FEATURE_VERSION} FEATURE_COUNT=${FEATURE_COUNT} hash=${FEATURE_NAMES_HASH}`,
  );

  // ── Import all subsystems (same as instrumentation.ts) ──────────────
  const [
    { startScheduler, stopScheduler, isSchedulerRunning },
    {
      startAutoSettleScheduler,
      stopAutoSettleScheduler,
      isAutoSettleActive,
      getAutoSettleStatus,
    },
    { notify },
    { listAutoPlaceStates },
    {
      startModelRetrainingScheduler,
      stopModelRetrainingScheduler,
      isModelRetrainingSchedulerActive,
    },
    { startTelegramBot, isTelegramBotRunning },
    { startResolverCacheListener, isResolverCacheListenerActive },
    { pinnacleSyncService },
    { geniusSportsSyncService },
    { sabaSyncService },
    { betconstructSyncService },
    { startReactiveDetector, stopReactiveDetector },
    { getRuntimeEnabledProviderIds, isProviderRuntimeEnabled },
    { getProviderDataSourceLabels },
  ] = await Promise.all([
    import("./lib/background/fetcher"),
    import("./lib/settle/scheduler"),
    import("./lib/notifier"),
    import("./lib/betting/auto-place-config"),
    import("./lib/optimizer/scheduler"),
    import("./lib/telegram/bot"),
    import("./lib/matching/entities/resolver"),
    import("./lib/services/pinnacle-sync-service"),
    import("./lib/services/genius-sports-sync-service"),
    import("./lib/services/saba-sync-service"),
    import("./lib/services/betconstruct-sync-service"),
    import("./lib/background/reactive-detector"),
    import("./lib/providers/runtime-state"),
    import("./lib/providers/registry"),
  ]);

  // ── Startup diagnostics ─────────────────────────────────────────────

  const hasTelegramCreds =
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_CHAT_ID);
  if (hasTelegramCreds) {
    logger.info("Boot", "Telegram credentials found — notifications enabled");
  } else {
    logger.warn(
      "Boot",
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — ALL Telegram notifications are disabled.",
    );
  }

  const autoPlaceStates = listAutoPlaceStates();
  for (const ap of autoPlaceStates) {
    if (!ap.enabled) {
      logger.warn(
        "Boot",
        `Auto-place is OFF for ${ap.provider} (${ap.providerDisplayName}).`,
      );
    } else {
      logger.info(
        "Boot",
        `Auto-place is ON for ${ap.provider} (${ap.providerDisplayName})`,
      );
    }
  }

  // ── Start schedulers ────────────────────────────────────────────────

  if (!isSchedulerRunning()) {
    startScheduler();
    logger.info("Boot", "Sync scheduler started");
  }

  if (!isAutoSettleActive()) {
    startAutoSettleScheduler();
    logger.info("Boot", "Auto-settle scheduler started");
  }

  if (!isModelRetrainingSchedulerActive()) {
    startModelRetrainingScheduler();
    logger.info(
      "Boot",
      `ML retraining scheduler started (Cloud Run Job: ${process.env.OPTIMIZER_JOB_NAME ?? "<unset>"} in ${process.env.GCP_REGION ?? "<unset>"})`,
    );
  }

  // Entity-resolution cache listener
  if (!isResolverCacheListenerActive()) {
    await startResolverCacheListener();
    logger.info("Boot", "Entity-resolver cache listener started");
  }

  // Real-time data sources
  pinnacleSyncService.start();
  logger.info("Boot", "Pinnacle WebSocket sync service started");

  geniusSportsSyncService.start();
  logger.info("Boot", "Genius Sports continuous polling sync service started");

  if (isProviderRuntimeEnabled("saba-sportsbook")) {
    sabaSyncService.start();
    logger.info("Boot", "SABA Socket.IO odds sync service started");
  } else {
    logger.info("Boot", "SABA provider disabled — skipping odds sync service");
  }

  if (isProviderRuntimeEnabled("betconstruct")) {
    betconstructSyncService.start();
    logger.info(
      "Boot",
      "BetConstruct WebSocket subscription sync service started",
    );
  } else {
    logger.info(
      "Boot",
      "BetConstruct provider disabled — skipping WebSocket sync service",
    );
  }

  // Reactive detector MUST start after real-time sync services
  startReactiveDetector();
  logger.info(
    "Boot",
    "Reactive value detector started (event-driven, 500ms debounce)",
  );

  // ML scorer warmup — check for deployed model metadata.
  // Non-blocking: scorer returns null (fail-open) when the Vertex AI Prediction
  // endpoint is unreachable or no model is deployed yet.
  import("./lib/ml/scorer")
    .then(({ ensureModel }) => ensureModel())
    .then(() => {
      logger.info(
        "Boot",
        "ML scorer initialized (Vertex AI Prediction; returns null until a model is deployed and reachable)",
      );
    })
    .catch((err) => {
      logger.error(
        "Boot",
        `ML scorer warmup FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  logger.info("Boot", "ML scorer warmup initiated (non-blocking)");

  // Warm up competition enrichment cache (non-blocking). Detection never
  // waits for AI; unknown competitions use tier 1 until the warmer catches up.
  import("./lib/ml/competition-enrichment")
    .then(({ startCompetitionEnrichmentWarmer }) =>
      startCompetitionEnrichmentWarmer(),
    )
    .catch(() => {});
  logger.info("Boot", "Competition enrichment warmer started (non-blocking)");

  // Telegram bot
  if (!isTelegramBotRunning()) {
    const started = startTelegramBot();
    logger.info(
      "Boot",
      started
        ? "Telegram control bot started (long-poll)"
        : "Telegram control bot disabled (token/chat-id not set)",
    );
  }

  // ── Engine HTTP API ──────────────────────────────────────────────────
  // Exposes in-memory state to the Next.js web process. Start this before
  // emitting boot payloads so frontend reachability checks observe readiness.
  const { startEngineHttp, stopEngineHttp, ENGINE_PORT } =
    await import("./lib/shared/engine-http");
  await startEngineHttp();

  // ── Boot notification ───────────────────────────────────────────────

  if (hasTelegramCreds) {
    const settleStatus = getAutoSettleStatus();
    const bootPayload = {
      type: "system:boot" as const,
      process: "engine" as const,
      at: new Date().toISOString(),
      nodeVersion: process.version,
      env: process.env.NODE_ENV ?? "development",
      pid: process.pid,
      enginePort: ENGINE_PORT,
      syncScheduler: isSchedulerRunning(),
      autoSettle: settleStatus.active,
      autoSettleIntervalSec: Math.round(settleStatus.intervalMs / 1000),
      autoPlace: autoPlaceStates.map((p) => ({
        provider: p.provider,
        displayName: p.providerDisplayName,
        enabled: p.enabled,
      })),
      dataSources: getProviderDataSourceLabels(getRuntimeEnabledProviderIds()),
      detectorDebounceMs: 500,
      mlRetrainJob: process.env.OPTIMIZER_JOB_NAME ?? null,
      mlRetrainRegion: process.env.GCP_REGION ?? null,
    };

    const { isUnifiedBoot, writeBootPayload } =
      await import("./lib/notifier/unified-boot");
    if (isUnifiedBoot()) {
      writeBootPayload("engine", bootPayload);
      logger.info("Boot", "Wrote engine boot payload for unified notification");
    } else {
      notify(bootPayload).catch((err: unknown) => {
        logger.warn(
          "Boot",
          `Telegram startup ping failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  logger.info("Engine", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(
    "Engine",
    `All subsystems started. Engine is running. HTTP API on :${ENGINE_PORT}`,
  );
  logger.info("Engine", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── Graceful shutdown ───────────────────────────────────────────────

  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Shutdown", `Received ${signal} — stopping all services...`);

    try {
      // Stop in reverse order of start
      await stopEngineHttp();
      stopReactiveDetector();
      // Stop ML model watcher (clean up interval timer)
      try {
        const { stopModelWatcher } = await import("./lib/ml/scorer");
        stopModelWatcher();
      } catch {
        /* scorer may not have been loaded */
      }
      try {
        const { stopCompetitionEnrichmentWarmer } =
          await import("./lib/ml/competition-enrichment");
        stopCompetitionEnrichmentWarmer();
      } catch {
        /* enrichment warmer may not have been loaded */
      }
      pinnacleSyncService.stop();
      geniusSportsSyncService.stop();
      sabaSyncService.stop();
      if (isProviderRuntimeEnabled("betconstruct")) {
        betconstructSyncService.stop();
      }
      stopScheduler();
      stopAutoSettleScheduler();
      stopModelRetrainingScheduler();

      // Clean up SofaScore transport (no-op for curl_cffi, kept for API compat)
      try {
        const { closeSofaScoreSession } =
          await import("./lib/settle/sources/sofascore-browser");
        await closeSofaScoreSession();
      } catch {
        /* sofascore-browser may not have been loaded */
      }

      logger.info("Shutdown", "Engine stopped cleanly.");
    } catch (err) {
      logger.error(
        "Shutdown",
        `Error during shutdown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Give pending I/O 2 seconds to flush, then force exit
    setTimeout(() => process.exit(0), 2000);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Process stays alive via active timers, WebSocket connections,
  // and polling loops — no keep-alive setInterval needed.
}

main().catch((err) => {
  console.error("[Engine] Fatal boot error:", err);
  process.exit(1);
});
