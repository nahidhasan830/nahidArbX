/**
 * Next.js server-boot hook. Runs once per server process, before any
 * request is served. This is how the sync + auto-settlement +
 * entity-resolution schedulers start: the system is headless, so the
 * backend pipeline runs whether or not anyone has opened the UI.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [
    { startScheduler, isSchedulerRunning },
    { startAutoSettleScheduler, isAutoSettleActive, getAutoSettleStatus },
    { notify },
    { listAutoPlaceStates },
    { logger },
    { startOptimizerScheduler, isOptimizerSchedulerActive },
    { startTelegramBot, isTelegramBotRunning },
    { startResolverCacheListener, isResolverCacheListenerActive },
  ] = await Promise.all([
    import("./lib/background/fetcher"),
    import("./lib/settle/scheduler"),
    import("./lib/notifier"),
    import("./lib/betting/auto-place-config"),
    import("./lib/shared/logger"),
    import("./lib/optimizer/scheduler"),
    import("./lib/telegram/bot"),
    import("./lib/matching/entities/resolver"),
  ]);

  // ── Startup diagnostics ──────────────────────────────────────────────

  const hasTelegramCreds =
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_CHAT_ID);
  if (hasTelegramCreds) {
    logger.info("Boot", "Telegram credentials found — notifications enabled");
  } else {
    logger.warn(
      "Boot",
      "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — ALL Telegram notifications are disabled. " +
        "Add them to .env (local) or docker-compose.yml environment section (Docker).",
    );
  }

  const autoPlaceStates = listAutoPlaceStates();
  for (const ap of autoPlaceStates) {
    if (!ap.enabled) {
      logger.warn(
        "Boot",
        `Auto-place is OFF for ${ap.provider} (${ap.providerDisplayName}). ` +
          "No bets will be auto-placed for this provider — toggle ON via the dashboard to enable.",
      );
    } else {
      logger.info(
        "Boot",
        `Auto-place is ON for ${ap.provider} (${ap.providerDisplayName})`,
      );
    }
  }

  // ── Start schedulers ─────────────────────────────────────────────────

  if (!isSchedulerRunning()) {
    startScheduler();
    logger.info("Boot", "Sync scheduler started");
  } else {
    logger.info("Boot", "Sync scheduler already running");
  }

  // Auto-settle: there is no kill-switch any more. Automatic AI usage
  // was removed entirely — settlement is deterministic Tier 0/1/2 only.
  // Manual AI re-runs still exist via the /bets UI.
  if (!isAutoSettleActive()) {
    startAutoSettleScheduler();
    logger.info("Boot", "Auto-settle scheduler started");
  } else {
    logger.info("Boot", "Auto-settle scheduler already running");
  }

  if (!isOptimizerSchedulerActive()) {
    startOptimizerScheduler();
    logger.info(
      "Boot",
      `Optimisation scheduler started (Cloud Run Job: ${process.env.OPTIMIZER_JOB_NAME ?? "<unset>"} in ${process.env.GCP_REGION ?? "<unset>"})`,
    );
  } else {
    logger.info("Boot", "Optimisation scheduler already running");
  }

  // Entity-resolution cross-worker cache listener — Postgres LISTEN on
  // the entities_invalidate channel. The auto-resolver fires NOTIFY on
  // every status flip; subscribers clear their LRU cache instantly so a
  // promotion in one worker shows up in every other worker. The
  // promoter + decay loop is gone (auto-resolve runs inline; weekly
  // trainer Cloud Run Job handles model retraining).
  if (!isResolverCacheListenerActive()) {
    await startResolverCacheListener();
    logger.info("Boot", "Entity-resolver cache listener started");
  } else {
    logger.info("Boot", "Entity-resolver cache listener already running");
  }

  if (!isTelegramBotRunning()) {
    const started = startTelegramBot();
    logger.info(
      "Boot",
      started
        ? "Telegram control bot started (long-poll)"
        : "Telegram control bot disabled (token/chat-id not set)",
    );
  }

  if (hasTelegramCreds) {
    const settleStatus = getAutoSettleStatus();
    notify({
      type: "system",
      at: new Date().toISOString(),
      severity: "info",
      message:
        `NahidArbX server started. Sync scheduler: ${isSchedulerRunning() ? "running" : "stopped"}. ` +
        `Auto-settle: ${settleStatus.active ? "running" : "stopped"}. ` +
        `Auto-place providers: ${autoPlaceStates.map((p) => `${p.provider}=${p.enabled ? "ON" : "OFF"}`).join(", ")}.`,
    }).catch((err: unknown) => {
      logger.warn(
        "Boot",
        `Telegram startup ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
