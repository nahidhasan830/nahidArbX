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
    { startAutoSettleScheduler, isAutoSettleActive },
    { isAutoSettleDisabled },
  ] = await Promise.all([
    import("./lib/background/fetcher"),
    import("./lib/settle/scheduler"),
    import("./lib/settle/kill-switch"),
  ]);

  if (!isSchedulerRunning()) {
    startScheduler();
  }

  if (!isAutoSettleActive() && !isAutoSettleDisabled()) {
    startAutoSettleScheduler();
  }
}
