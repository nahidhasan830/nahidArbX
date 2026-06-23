export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { ensureDbReady } = await import("./lib/db/client");
  await ensureDbReady();

  const { logger } = await import("./lib/shared/logger");
  logger.info(
    "Boot",
    "Next.js running in web-only mode (engine runs separately)",
  );

  const hasTgCreds =
    Boolean(process.env.TELEGRAM_BOT_TOKEN) &&
    Boolean(process.env.TELEGRAM_CHAT_ID);

  if (hasTgCreds) {
    const { notify } = await import("./lib/notifier");
    const { waitForEngineReachable, ENGINE_BASE_URL } =
      await import("./lib/engine-proxy");
    const reachable = await waitForEngineReachable();
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

    const { isUnifiedBoot, writeBootPayload, waitForBootPayloads } =
      await import("./lib/notifier/unified-boot");
    if (isUnifiedBoot()) {
      writeBootPayload("frontend", frontendPayload);
      const payloads = await waitForBootPayloads(["engine", "frontend"]);
      const engine = payloads.find((p) => p.role === "engine");
      const frontend = payloads.find((p) => p.role === "frontend");

      notify({
        type: "system:unified_boot",
        at: new Date().toISOString(),
        engine: engine?.data as
          | import("./lib/notifier/types").SystemBootEvent
          | undefined,
        frontend: frontend?.data as
          | import("./lib/notifier/types").SystemBootEvent
          | undefined,
      }).catch((err: unknown) => {
        logger.warn(
          "Boot",
          `Telegram unified boot ping failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      logger.info(
        "Boot",
        `Unified boot notification sent (${payloads.map((p) => p.role).join(" + ")})`,
      );
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
