/**
 * Next.js server-boot hook. Runs once per server process, before any
 * request is served. This is how the sync + auto-settlement schedulers
 * start: the system is headless, so the backend pipeline runs whether
 * or not anyone has opened the UI.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const [
    { startScheduler, isSchedulerRunning },
    { startAutoSettleScheduler, isAutoSettleActive, getAutoSettleStatus },
    { isAutoSettleDisabled, getKillSwitchState },
    { notify },
    { listAutoPlaceStates },
    { logger },
    { startOptimizerScheduler, isOptimizerSchedulerActive },
  ] = await Promise.all([
    import("./lib/background/fetcher"),
    import("./lib/settle/scheduler"),
    import("./lib/settle/kill-switch"),
    import("./lib/notifier"),
    import("./lib/betting/auto-place-config"),
    import("./lib/shared/logger"),
    import("./lib/optimizer/scheduler"),
  ]);

  // ── Startup diagnostics ──────────────────────────────────────────────
  // Log the state of every subsystem that affects Telegram notifications
  // so missing pings can be diagnosed from server logs without guessing.

  // Telegram creds check
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

  // Auto-place toggle state
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

  // Kill-switch / auto-settle state
  const killSwitch = getKillSwitchState();
  if (killSwitch.disabled) {
    logger.warn(
      "Boot",
      `Auto-settle kill-switch is ENGAGED (reason: ${killSwitch.reason ?? "none"}). ` +
        "Settlement scheduler will NOT start — re-enable via the dashboard or delete sessions/auto-settle-config.json.",
    );
  }

  // ── Start schedulers ─────────────────────────────────────────────────

  if (!isSchedulerRunning()) {
    startScheduler();
    logger.info("Boot", "Sync scheduler started");
  } else {
    logger.info("Boot", "Sync scheduler already running");
  }

  if (!isAutoSettleActive() && !isAutoSettleDisabled()) {
    startAutoSettleScheduler();
    logger.info("Boot", "Auto-settle scheduler started");
  } else if (isAutoSettleActive()) {
    logger.info("Boot", "Auto-settle scheduler already running");
  } else {
    logger.warn(
      "Boot",
      "Auto-settle scheduler NOT started — kill-switch is engaged",
    );
  }

  // Optimisation queue poller — kicks the Python sidecar for any
  // optimization_runs row in status='queued'. No-op if the sidecar is down;
  // the next tick (30s) will retry.
  if (!isOptimizerSchedulerActive()) {
    startOptimizerScheduler();
    logger.info(
      "Boot",
      `Optimisation scheduler started (Cloud Run Job: ${process.env.OPTIMIZER_JOB_NAME ?? "<unset>"} in ${process.env.GCP_REGION ?? "<unset>"})`,
    );
  } else {
    logger.info("Boot", "Optimisation scheduler already running");
  }

  // ── Telegram startup ping ────────────────────────────────────────────
  // Fire a system notification on boot so the operator can confirm
  // Telegram connectivity immediately (no need to wait for a bet).
  if (hasTelegramCreds) {
    const settleStatus = getAutoSettleStatus();
    notify({
      type: "system",
      at: new Date().toISOString(),
      severity: "info",
      message:
        `NahidArbX server started. Sync scheduler: ${isSchedulerRunning() ? "running" : "stopped"}. ` +
        `Auto-settle: ${settleStatus.active ? "running" : killSwitch.disabled ? "kill-switch engaged" : "stopped"}. ` +
        `Auto-place providers: ${autoPlaceStates.map((p) => `${p.provider}=${p.enabled ? "ON" : "OFF"}`).join(", ")}.`,
    }).catch((err: unknown) => {
      logger.warn(
        "Boot",
        `Telegram startup ping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
}
