/**
 * Control commands (safe writes — no confirm flow):
 *   /sync, /scheduler, /settle, /autoplace (off-only),
 *   /refreshtoken, /reconcile, /cache.
 *
 * The /ai kill-switch command was removed in 2026 along with all
 * automatic Gemini AI usage. Manual AI re-runs still happen from the
 * /bets web UI.
 */

import {
  isSchedulerRunning,
  isSchedulerPausedState,
  pauseScheduler,
  resumeScheduler,
  startScheduler,
  stopScheduler,
  restartScheduler,
  syncAll,
  syncFixturesOnly,
} from "@/lib/background/fetcher";
import { triggerDetection } from "@/lib/background/reactive-detector";
import {
  pauseAutoSettleScheduler,
  resumeAutoSettleScheduler,
  startAutoSettleScheduler,
  stopAutoSettleScheduler,
  triggerAutoSettleNow,
  isAutoSettleActive,
  isAutoSettlePaused,
} from "@/lib/settle/scheduler";
import {
  listAutoPlaceStates,
  setAutoPlaceEnabled,
} from "@/lib/betting/auto-place-config";
import { refreshTokenIfNeeded } from "@/lib/auth/token-manager";
import { reconcilePendingBets } from "@/lib/betting/ninewickets/reconciler";
import { resetValueCache } from "@/lib/atoms/value-detector";
import { invalidateResponseCache } from "@/lib/cache/response-cache";
import { toggleProviderAction } from "@/lib/providers/actions";
import { isProviderRuntimeEnabled } from "@/lib/providers/runtime-state";
import {
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  type ProviderKey,
} from "@/lib/providers/registry";
import { syncTelegramCommandMenu } from "../menu";
import { registerCommand } from "../registry";
import { esc, header, kvList } from "../format";

// ── /sync [fixtures|odds] ────────────────────────────────────────────────

registerCommand({
  name: "sync",
  usage: "/sync [fixtures|odds]",
  description: "Trigger a manual sync now.",
  explanation:
    "Kicks off a sync immediately — full pipeline by default, or one phase only with /sync fixtures (events + matching) or /sync odds (markets + value detection). Fire-and-forget; the bot returns once the sync has been started, the actual work continues in the background. Use /status afterwards to see the result.",
  group: "control",
  async handler({ args, reply }) {
    const phase = (args[0] ?? "all").toLowerCase();
    if (phase === "fixtures") {
      void syncFixturesOnly();
      await reply("🔄 Fixtures sync triggered.");
    } else if (phase === "odds") {
      triggerDetection();
      await reply("🔄 Reactive detection triggered.");
    } else {
      void syncAll();
      await reply("🔄 Full sync triggered (fixtures + matching + odds).");
    }
    return { alreadyReplied: true };
  },
});

// ── /commandsync ────────────────────────────────────────────────────────

registerCommand({
  name: "commandsync",
  usage: "/commandsync",
  description: "Refresh Telegram slash-command autosuggestions.",
  explanation:
    "Republishes the bot's slash-command menu to Telegram using the currently enabled command list. Use this after adding, removing, enabling, or disabling commands if Telegram's / autosuggestions look stale.",
  group: "control",
  async handler({ reply }) {
    try {
      const count = await syncTelegramCommandMenu();
      await reply(`✅ Telegram autosuggestions refreshed (${count} commands).`);
    } catch (err) {
      await reply(`⚠️ Command sync failed: ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});

// ── /scheduler ───────────────────────────────────────────────────────────

registerCommand({
  name: "scheduler",
  usage: "/scheduler [pause|resume|stop|start|restart|status]",
  description: "Control the background sync scheduler.",
  explanation:
    "The sync scheduler runs fixtures every 2 minutes and odds every 15 seconds in the background. /scheduler with no arg shows current state. " +
    "pause = keep timers ticking but skip syncs (instant resume). resume = unpause. " +
    "stop = tear down timers entirely. start = rebuild them. restart = stop + start. " +
    "Pause is what you want when you're poking around in the dashboard and don't want background traffic; stop is for shutting it down.",
  group: "control",
  async handler({ args, reply }) {
    const action = (args[0] ?? "status").toLowerCase();
    switch (action) {
      case "pause":
        pauseScheduler();
        await reply("⏸ Sync scheduler paused.");
        return { alreadyReplied: true };
      case "resume":
        resumeScheduler();
        await reply("▶️ Sync scheduler resumed.");
        return { alreadyReplied: true };
      case "stop":
        stopScheduler();
        await reply("⏹ Sync scheduler stopped.");
        return { alreadyReplied: true };
      case "start":
        startScheduler();
        await reply("▶️ Sync scheduler started.");
        return { alreadyReplied: true };
      case "restart":
        restartScheduler();
        await reply("🔁 Sync scheduler restarted.");
        return { alreadyReplied: true };
      case "status":
      default: {
        const lines = [
          header("🔄", "Sync scheduler"),
          kvList([
            ["Active", isSchedulerRunning() ? "🟢 yes" : "⚪ no"],
            ["Paused", isSchedulerPausedState() ? "⏸ yes" : "—"],
          ]),
        ];
        await reply(lines.join("\n"));
        return { alreadyReplied: true };
      }
    }
  },
});

// ── /settle ──────────────────────────────────────────────────────────────

registerCommand({
  name: "settle",
  usage: "/settle [pause|resume|stop|start|restart|run|status]",
  description: "Control the auto-settle scheduler.",
  explanation:
    "Auto-settle resolves pending placed bets by walking the deterministic tier waterfall (cache → live feed → free APIs). " +
    "pause = skip ticks but keep timer ticking. resume = unpause. stop / start = tear down / rebuild. run = trigger one tick now. " +
    "Default 'status' shows scheduler state.",
  group: "control",
  async handler({ args, reply }) {
    const action = (args[0] ?? "status").toLowerCase();
    switch (action) {
      case "pause":
        pauseAutoSettleScheduler();
        await reply("⏸ Auto-settle paused.");
        return { alreadyReplied: true };
      case "resume":
        resumeAutoSettleScheduler();
        await reply("▶️ Auto-settle resumed.");
        return { alreadyReplied: true };
      case "stop":
        stopAutoSettleScheduler();
        await reply("⏹ Auto-settle stopped.");
        return { alreadyReplied: true };
      case "start":
        startAutoSettleScheduler();
        await reply("▶️ Auto-settle started.");
        return { alreadyReplied: true };
      case "restart":
        stopAutoSettleScheduler();
        startAutoSettleScheduler();
        await reply("🔁 Auto-settle restarted.");
        return { alreadyReplied: true };
      case "run":
        try {
          const r = await triggerAutoSettleNow();
          await reply(
            `▶️ Tick complete: scanned ${r.scannedBets}, settled ${r.settled}, applied ${r.applied}, still pending ${r.stillPending}.`,
          );
        } catch (err) {
          await reply(`⚠️ Tick failed: ${esc((err as Error).message)}`);
        }
        return { alreadyReplied: true };
      case "status":
      default: {
        const lines = [
          header("📩", "Auto-settle"),
          kvList([
            ["Active", isAutoSettleActive() ? "🟢 yes" : "⚪ no"],
            ["Paused", isAutoSettlePaused() ? "⏸ yes" : "—"],
          ]),
        ];
        await reply(lines.join("\n"));
        return { alreadyReplied: true };
      }
    }
  },
});

// ── /autoplace [provider] [off] ─ OFF-ONLY ───────────────────────────────

registerCommand({
  name: "autoplace",
  usage: "/autoplace [provider [off]]",
  description: "Show auto-place state per provider; turn OFF only.",
  explanation:
    "Auto-place is the 'detect → place' pipeline that submits real money to a book without operator review. " +
    "From Telegram you can <b>turn it OFF</b> for a provider as a kill-switch (e.g. <code>/autoplace ninewickets-sportsbook off</code>) " +
    "but you cannot turn it ON — that direction must happen from the web dashboard where you have full context. " +
    "With no args, lists every provider's current state.",
  group: "control",
  async handler({ args, reply }) {
    const states = listAutoPlaceStates();
    if (args.length === 0) {
      const lines = [header("✋", "Auto-place state")];
      for (const s of states) {
        lines.push(
          "",
          `${s.enabled ? "🟢" : "⚪"} <b>${esc(s.providerDisplayName)}</b>`,
          `<code>${esc(s.provider)}</code> · ${s.enabled ? "ON" : "OFF"}`,
        );
      }
      lines.push(
        "",
        "<i>To disable: /autoplace &lt;providerId&gt; off. Enabling must happen from the dashboard.</i>",
      );
      await reply(lines.join("\n"));
      return { alreadyReplied: true };
    }
    const providerId = args[0];
    const target = (args[1] ?? "").toLowerCase();
    const known = states.find(
      (s) =>
        s.provider === providerId ||
        s.provider.toLowerCase() === providerId.toLowerCase(),
    );
    if (!known) {
      await reply(`⚠️ Unknown provider <code>${esc(providerId)}</code>.`);
      return { alreadyReplied: true };
    }
    if (target === "off" || target === "0" || target === "false") {
      setAutoPlaceEnabled(known.provider, false);
      await reply(
        `🚫 Auto-place OFF for <b>${esc(known.providerDisplayName)}</b>.`,
      );
    } else if (target === "on" || target === "1" || target === "true") {
      await reply(
        `Use /autoplaceon ${esc(known.provider)} (confirm-gated) to enable. This route is read/disable-only.`,
      );
    } else {
      await reply(
        `${known.enabled ? "🟢 ON" : "⚪ OFF"} — <b>${esc(known.providerDisplayName)}</b>. To disable: /autoplace ${known.provider} off.`,
      );
    }
    return { alreadyReplied: true };
  },
});

// ── /refreshtoken ────────────────────────────────────────────────────────

registerCommand({
  name: "refreshtoken",
  usage: "/refreshtoken",
  description: "Force a Pinnacle Bearer-token refresh.",
  explanation:
    "Pinnacle requires a Bearer token captured via betjili that expires after ~1h. Sync auto-refreshes when TTL drops below 20 minutes, " +
    "but if a sync is failing because the token went missing you can force the refresh now. The capture runs server-side; this command returns " +
    "once the refresh attempt finishes (success or failure surfaces in the reply).",
  group: "control",
  async handler({ reply }) {
    try {
      const ok = await refreshTokenIfNeeded();
      await reply(
        ok
          ? "✅ Pinnacle token refresh attempted (check /health for new TTL)."
          : "ℹ️ Refresh skipped — current token still valid.",
      );
    } catch (err) {
      await reply(`⚠️ Refresh failed: ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});

// ── /reconcile ───────────────────────────────────────────────────────────

registerCommand({
  name: "reconcile",
  usage: "/reconcile",
  description: "Trigger NineWickets pending-bet reconciliation now.",
  explanation:
    "The reconciler polls the book's myBets feed every 30s to attach ticket ids to bets that returned 'pending' from /place, and to purge orphans " +
    "older than the TTL. Use this command if you placed a bet manually and want the ticket id to land in the dashboard immediately rather than waiting " +
    "for the next 30s tick.",
  group: "control",
  async handler({ reply }) {
    try {
      const r = await reconcilePendingBets();
      await reply(
        `✅ Reconcile: tickets attached ${r.ticketsAttached} · orphans purged ${r.orphansPurged} · still pending ${r.pendingAfter}`,
      );
    } catch (err) {
      await reply(`⚠️ Reconcile failed: ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});

// ── /cache ───────────────────────────────────────────────────────────────

registerCommand({
  name: "cache",
  usage: "/cache reset",
  description: "Reset the value-detector + response cache.",
  explanation:
    "Clears the in-memory value-detection cache (forces full recomputation on the next odds sync) and the HTTP response cache. " +
    "Useful when you've just changed settings and want to see the effect without waiting for caches to expire naturally.",
  group: "control",
  async handler({ args, reply }) {
    const action = (args[0] ?? "").toLowerCase();
    if (action !== "reset") {
      await reply("Usage: /cache reset");
      return { alreadyReplied: true };
    }
    resetValueCache();
    invalidateResponseCache();
    await reply("✅ Caches reset (value-detect, response).");
    return { alreadyReplied: true };
  },
});

// ── /provider [id] [on|off] ──────────────────────────────────────────────

registerCommand({
  name: "provider",
  usage: "/provider [id] [on|off]",
  description: "Enable or disable a provider (fetches, odds, matching).",
  explanation:
    "Without arguments, lists the current enabled/disabled state of all providers. " +
    "To turn a provider on or off, pass its ID and the desired state (e.g., /provider ninewickets-exchange off). " +
    "Turning a provider off immediately purges its data from the active event store.",
  group: "control",
  async handler({ args, reply }) {
    if (args.length === 0) {
      const lines = [header("🔌", "Providers Status")];
      for (const id of PROVIDER_IDS) {
        const meta = PROVIDER_REGISTRY[id];
        const enabled = isProviderRuntimeEnabled(id);
        lines.push(`${enabled ? "🟢" : "⚪"} <b>${esc(meta.displayName)}</b>`);
        lines.push(`<code>${esc(id)}</code> · ${enabled ? "ON" : "OFF"}`);
        lines.push("");
      }
      lines.push("<i>Usage: /provider &lt;id&gt; [on|off]</i>");
      await reply(lines.join("\n"));
      return { alreadyReplied: true };
    }

    const providerIdRaw = args[0];
    const meta =
      PROVIDER_REGISTRY[providerIdRaw as ProviderKey] ||
      Object.values(PROVIDER_REGISTRY).find(
        (p) =>
          p.shortName.toLowerCase() === providerIdRaw.toLowerCase() ||
          p.id.toLowerCase() === providerIdRaw.toLowerCase(),
      );

    if (!meta) {
      await reply(`⚠️ Unknown provider <code>${esc(providerIdRaw)}</code>.`);
      return { alreadyReplied: true };
    }

    const stateArg = (args[1] ?? "").toLowerCase();
    if (stateArg !== "on" && stateArg !== "off") {
      await reply(`Usage: /provider ${esc(meta.id)} [on|off]`);
      return { alreadyReplied: true };
    }

    const enable = stateArg === "on";
    const purged = toggleProviderAction(meta.id as ProviderKey, enable);

    if (enable) {
      await reply(
        `🟢 <b>${esc(meta.displayName)}</b> is now ON. Data will repopulate on the next sync.`,
      );
    } else {
      await reply(
        `⚪ <b>${esc(meta.displayName)}</b> is now OFF. Purged ${purged} event(s) from memory.`,
      );
    }
    return { alreadyReplied: true };
  },
});
