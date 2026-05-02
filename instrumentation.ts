/**
 * Next.js server-boot hook. Runs once per server process, before any
 * request is served.
 *
 * In the dual-process architecture, Next.js is UI-only — all background
 * subsystems (sync, detection, settlement, WebSockets, Telegram) run
 * in the standalone engine process (engine.ts). This file only
 * initialises the DB pool and sends a lightweight frontend-boot
 * Telegram notification.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Initialize database pool — needed for DB-backed API routes
  // (bets, settlement, settings, accounts, etc.)
  const { ensureDbReady } = await import("./lib/db/client");
  await ensureDbReady();

  const { logger } = await import("./lib/shared/logger");
  logger.info("Boot", "Next.js running in web-only mode (engine runs separately)");

  // Send frontend-boot Telegram notification
  const hasTgCreds =
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_CHAT_ID);

  if (hasTgCreds) {
    const { notify } = await import("./lib/notifier");
    const { isEngineReachable, ENGINE_BASE_URL } = await import("./lib/engine-proxy");
    const reachable = await isEngineReachable();
    // Access Node.js-only globals indirectly to avoid Edge Runtime
    // static-analysis warnings (this code is guarded by NEXT_RUNTIME check above)
    const proc = globalThis.process;
    const frontendPayload = {
      type: "system:boot" as const,
      process: "frontend" as const,
      at: new Date().toISOString(),
      nodeVersion: proc.version,
      env: proc.env.NODE_ENV ?? "development",
      pid: proc.pid,
      engineUrl: ENGINE_BASE_URL,
      engineReachable: reachable,
    };

    const { isUnifiedBoot, writeBootPayload, collectBootPayloads } = await import("./lib/notifier/unified-boot");
    if (isUnifiedBoot()) {
      // Write our own payload, then collect all and send one unified notification
      writeBootPayload("frontend", frontendPayload);
      const payloads = collectBootPayloads();
      const engine = payloads.find((p) => p.role === "engine");
      const aiSearch = payloads.find((p) => p.role === "ai-search");
      const frontend = payloads.find((p) => p.role === "frontend");

      notify({
        type: "system:unified_boot",
        at: new Date().toISOString(),
        engine: engine?.data as import("./lib/notifier/types").SystemBootEvent | undefined,
        aiSearch: aiSearch?.data as import("./lib/notifier/types").AiEngineStateEvent | undefined,
        frontend: frontend?.data as import("./lib/notifier/types").SystemBootEvent | undefined,
      }).catch((err: unknown) => {
        logger.warn(
          "Boot",
          `Telegram unified boot ping failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      logger.info("Boot", `Unified boot notification sent (${payloads.map((p) => p.role).join(" + ")})`);
    } else {
      notify(frontendPayload).catch((err: unknown) => {
        logger.warn(
          "Boot",
          `Telegram frontend-boot ping failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }
}
