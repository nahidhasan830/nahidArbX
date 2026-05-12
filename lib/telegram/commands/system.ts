/**
 * System / operational reads:
 *   /status, /health, /freshness, /scores, /notifs, /errors, /spend, /proxy
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getAllProviderStatus, getSyncStatus } from "@/lib/store";
import {
  isSchedulerRunning,
  isSchedulerPausedState,
} from "@/lib/background/fetcher";
import { getAutoSettleStatus } from "@/lib/settle/scheduler";
import { listAutoPlaceStates } from "@/lib/betting/auto-place-config";
import { getTokenTTL } from "@/lib/auth/token-manager";
import { getConnectionHealth as getBCConnectionHealth } from "@/lib/adapters/betconstruct/client";
import {
  isScoreWebSocketConnected,
  getConnectionHealth as getScoresConnectionHealth,
} from "@/lib/scores/websocket";
import { isBCPollingActive, getBCPollingCount } from "@/lib/scores/bc-poller";
import { getBrowserSessionStats } from "@/lib/settle/sources/sofascore-browser";
import { getApiFootballQuota } from "@/lib/settle/sources/api-football";
import {
  PROVIDER_REGISTRY,
  getProviderShortName,
  type ProviderKey,
} from "@/lib/providers/registry";
import { registerCommand } from "../registry";
import {
  ago,
  b,
  bool,
  durationLabel,
  esc,
  header,
  kvList,
  num,
  signedMoney,
  statusEmoji,
} from "../format";
import { getRecentNotifications } from "../recent";
import { getCommandHistory, getCommandHistoryStats } from "../history";
import { getRecentLoggedErrors } from "@/lib/shared/logger";

registerCommand({
  name: "status",
  usage: "/status",
  description: "One-glance system snapshot.",
  explanation:
    "Pulls the headline state of every subsystem so you can tell at a glance if the system is fetching, settling, and auto-placing. Includes sync scheduler, auto-settle scheduler, auto-place toggles per provider, and current value-bet count. Example: '🟢 Sync running · 🟢 Auto-settle running · NW-SB auto OFF · 23 value bets'.",
  group: "read",
  async handler({ reply }) {
    const sync = getSyncStatus();
    const settle = getAutoSettleStatus();
    const ap = listAutoPlaceStates();
    const lines: string[] = [];
    lines.push(header("🤖", "Status"));
    lines.push("");
    lines.push(header("🔄", "Sync"));
    lines.push(
      kvList([
        [
          "Scheduler",
          `${statusEmoji(isSchedulerRunning() ? "running" : "stopped")} ${bool(isSchedulerRunning(), "running", "stopped")}${isSchedulerPausedState() ? " (paused)" : ""}`,
        ],
        ["Currently", sync.isSyncing ? `🟡 ${sync.currentPhase}` : "idle"],
        ["Last sync", sync.lastSyncEnd ? ago(sync.lastSyncEnd) : "never"],
        [
          "Last duration",
          sync.lastSyncDuration ? durationLabel(sync.lastSyncDuration) : "—",
        ],
        ["Markets last", num(sync.lastMarketsCount)],
      ]),
    );
    lines.push("");
    lines.push(header("📩", "Auto-settle"));
    lines.push(
      kvList([
        [
          "State",
          `${statusEmoji(settle.active ? "running" : settle.paused ? "paused" : "stopped")} ${settle.active ? "running" : settle.paused ? "paused" : "stopped"}`,
        ],
        [
          "Last tick",
          settle.lastFinishedAt
            ? ago(new Date(settle.lastFinishedAt))
            : "never",
        ],
        ["Total applied", num(settle.totalApplied)],
      ]),
    );
    lines.push("");
    lines.push(header("✋", "Auto-place"));
    if (ap.length === 0) lines.push("No betting providers registered.");
    else
      lines.push(
        ap
          .map(
            (p) =>
              `• ${esc(p.providerDisplayName)} — ${p.enabled ? "🟢 ON" : "⚪ OFF"}`,
          )
          .join("\n"),
      );
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "health",
  usage: "/health",
  description: "Provider connections + Pinnacle token TTL + last sync error.",
  explanation:
    "The deeper diagnostic view — checks every external connection: Pinnacle token TTL, BetConstruct WebSocket, NineWickets HTTP freshness, score WebSocket, and BetConstruct score poller. Use this when /status looks fine but value bets stop appearing — a stale token or dropped WS often shows up here first. Example: 'Pinnacle token expires in 47m · BC WS connected · NW-SB last fetch 12s ago'.",
  group: "read",
  async handler({ reply }) {
    const ps = getAllProviderStatus();
    const ttl = getTokenTTL();
    const bc = getBCConnectionHealth();
    const sc = getScoresConnectionHealth();
    const lines: string[] = [header("🩺", "Health"), ""];
    lines.push(b("Pinnacle token"));
    lines.push(
      `• ${ttl !== null && ttl > 0 ? `🟢 valid · expires in ${durationLabel(ttl)}` : "🔴 missing/expired"}`,
    );
    lines.push("");
    lines.push(b("BetConstruct WS"));
    lines.push(
      `• ${bc.connected ? "🟢 connected" : "🔴 disconnected"} · pending ${bc.pendingRequests} · timeouts ${bc.consecutiveTimeouts}`,
    );
    lines.push("");
    lines.push(b("Scores WS"));
    lines.push(
      `• ${sc.connected ? "🟢 connected" : "🔴 disconnected"} · subs ${sc.subscribedEvents}`,
    );
    lines.push("");
    lines.push(b("BC score poller"));
    lines.push(
      `• ${isBCPollingActive() ? "🟢 polling" : "⚪ idle"} · events ${getBCPollingCount()}`,
    );
    lines.push("");
    lines.push(b("Provider HTTP"));
    for (const id of Object.keys(PROVIDER_REGISTRY) as ProviderKey[]) {
      const s = ps[id];
      const last = s.lastFetch ? ago(s.lastFetch) : "never";
      lines.push(
        `• ${esc(getProviderShortName(id))}: ${statusEmoji(s.status)} ${s.status} · last ${last}${s.error ? ` · ${esc(s.error.slice(0, 80))}` : ""}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "freshness",
  usage: "/freshness",
  description: "Last successful fetch per provider — lag detector.",
  explanation:
    "Shows how stale each provider's data is right now. If NineWickets-Sportsbook hasn't returned a fixture in 4 minutes while Pinnacle is current, you know the soft side is the problem before opening the dashboard. Example: 'pin: 12s ago · 9w-sb: 3m12s ago · 9w-ex: 14s ago · bc: 8s ago'.",
  group: "read",
  async handler({ reply }) {
    const ps = getAllProviderStatus();
    const lines: string[] = [header("⏱", "Freshness")];
    for (const id of Object.keys(PROVIDER_REGISTRY) as ProviderKey[]) {
      const s = ps[id];
      const lag = s.lastFetch ? ago(s.lastFetch) : "never";
      lines.push(
        `• ${esc(getProviderShortName(id))}: ${statusEmoji(s.status)} last ${lag}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "scores",
  usage: "/scores",
  description: "Score WebSocket + BC poller + Pinnacle live coverage.",
  explanation:
    "Reports the state of every score-tracking subsystem. Settlement depends on these — if scores aren't flowing, settled bets pile up in 'pending'. Shows whether Pinnacle WS is connected, BetConstruct poller is active, and how many events are subscribed to each. Example: 'Pinnacle WS connected · 47 subs · BC polling 12 events'.",
  group: "read",
  async handler({ reply }) {
    const ws = isScoreWebSocketConnected();
    const wsHealth = getScoresConnectionHealth();
    const lines: string[] = [
      header("📺", "Scores"),
      "",
      b("Pinnacle scores WS"),
      `• ${ws ? "🟢 connected" : "🔴 disconnected"} · subscribed ${wsHealth.subscribedEvents} · failures ${wsHealth.consecutiveFailures}`,
      "",
      b("BetConstruct score poller"),
      `• ${isBCPollingActive() ? "🟢 polling" : "⚪ idle"} · events ${getBCPollingCount()}`,
    ];
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "notifs",
  usage: "/notifs [n]",
  description: "Last N Telegram cards sent (default 10).",
  explanation:
    "Shows the most recent outbound Telegram notifications — bet placed, bet settled, run started, etc. Useful for confirming whether a notification you expected actually fired (e.g. you bet on a goal-fest but no settlement card arrived). Default is the last 10. Buffer is in-memory so it resets on server restart.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(50, Math.max(1, parseInt(args[0] ?? "10", 10) || 10));
    const recent = getRecentNotifications(n);
    if (recent.length === 0) {
      await reply("No notifications captured yet.");
      return { alreadyReplied: true };
    }
    const lines = [header("📨", `Last ${recent.length} notifications`), ""];
    for (const r of recent) {
      lines.push(
        `• ${esc(ago(r.at))} · <i>${esc(r.type)}</i> — ${esc(r.summary)}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "errors",
  usage: "/errors [n]",
  description: "Last N system errors logged (default 10).",
  explanation:
    "Tail of the recent error log — anything the server logged at error level. Use when you suspect background failures (failed placements, sync errors, settlement timeouts). Default is the last 10. Buffer is in-memory and capped at 100, so this is a quick view, not a full audit log.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(50, Math.max(1, parseInt(args[0] ?? "10", 10) || 10));
    const recent = getRecentLoggedErrors(n);
    if (recent.length === 0) {
      await reply("✅ No recent errors logged.");
      return { alreadyReplied: true };
    }
    const lines = [header("⚠️", `Last ${recent.length} errors`), ""];
    for (const r of recent) {
      lines.push(
        `• ${esc(ago(r.at))} · <code>${esc(r.ctx)}</code> — ${esc(r.msg.slice(0, 200))}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "spend",
  usage: "/spend",
  description: "Settlement-pipeline AI spend this month + tier-hit breakdown.",
  explanation:
    "Aggregates settlement_runs since the 1st of this month so you can see if Gemini cost is creeping up. Shows total estimated USD spend, tier-1 (free), tier-2 (free), tier-3 (paid url_context), and tier-4 (batched Gemini) hit counts. The April 2026 incident burned $35+ when one wrong URL blew the cap — this command exists to catch that earlier.",
  group: "read",
  async handler({ reply }) {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const startIso = start.toISOString();
    try {
      const res = await db.execute(sql`
        SELECT
          COALESCE(SUM(estimated_cost_usd), 0)::float AS spend,
          COALESCE(SUM(tier0_hits), 0)::int AS t0,
          COALESCE(SUM(tier1_hits), 0)::int AS t1,
          COALESCE(SUM(tier2_hits), 0)::int AS t2,
          COALESCE(SUM(tier3_hits), 0)::int AS t3,
          COALESCE(SUM(tier4_hits), 0)::int AS t4,
          COUNT(*)::int AS ticks
        FROM settlement_runs
        WHERE started_at >= ${startIso}::timestamptz
      `);
      const row = (res.rows[0] ?? {}) as {
        spend?: number;
        t0?: number;
        t1?: number;
        t2?: number;
        t3?: number;
        t4?: number;
        ticks?: number;
      };
      const spend = Number(row.spend ?? 0);
      const lines = [
        header("💵", `Settlement spend (since ${startIso.slice(0, 10)})`),
        "",
        `• ${b("Total")}: ${signedMoney(-spend, "USD").replace("−", "")}  <i>(estimate)</i>`,
        `• Ticks: ${num(row.ticks ?? 0)}`,
        "",
        b("Tier hits (free → paid)"),
        `• T0 cache: ${num(row.t0 ?? 0)}`,
        `• T1 live feed: ${num(row.t1 ?? 0)}`,
        `• T2 free APIs: ${num(row.t2 ?? 0)}`,
        `• T3 url_context: ${num(row.t3 ?? 0)}  <i>paid</i>`,
        `• T4 Gemini batch: ${num(row.t4 ?? 0)}  <i>paid</i>`,
      ];
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(
        `⚠️ Could not query settlement_runs: ${esc((err as Error).message)}`,
      );
    }
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "proxy",
  usage: "/proxy",
  description: "Data-source health: API-Football quota + SofaScore curl_cffi.",
  explanation:
    "Shows API-Football quota (Tier 2b, 100 req/day free) and SofaScore curl_cffi transport status (Tier 2c). SofaScore uses Python curl_cffi to impersonate Chrome's TLS fingerprint and bypass Cloudflare.",
  group: "read",
  async handler({ reply }) {
    const apiFb = getApiFootballQuota();
    const sofa = getBrowserSessionStats();
    const lines = [
      header("🌐", "Settlement data sources"),
      "",
      b("API-Football (Tier 2b — 100 req/day)"),
      kvList([
        ["Daily limit", num(apiFb.dailyLimit)],
        ["Used today", num(apiFb.used)],
        ["Remaining", num(apiFb.remaining)],
        ["Status", apiFb.remaining > 10 ? "🟢 healthy" : apiFb.remaining > 0 ? "🟡 low" : "🔴 exhausted"],
      ]),
      "",
      b("SofaScore (Tier 2c — curl_cffi TLS impersonation)"),
      kvList([
        ["Status", sofa.alive ? "🟢 healthy" : "🔴 degraded (5+ failures)"],
        ["Requests served", num(sofa.requestCount)],
        [
          "Idle",
          sofa.lastUsedAt > 0
            ? durationLabel(sofa.idleMs)
            : "never used",
        ],
      ]),
    ];
    if (apiFb.remaining === 0) {
      lines.push(
        "",
        "⚠️ <i>API-Football daily limit exhausted — niche leagues will fall through to SofaScore/AI.</i>",
      );
    }
    if (!sofa.alive) {
      lines.push(
        "",
        "ℹ️ <i>SofaScore session will auto-start on next settlement tick.</i>",
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /history ─────────────────────────────────────────────────────────────

registerCommand({
  name: "history",
  usage: "/history [n]",
  description: "Last N incoming commands the bot has dispatched (default 15).",
  explanation:
    "Tail of the bot's command-dispatch log so you can review what you (or any incoming chat) recently fired off, with timing and outcome. Useful for confirming a command actually reached the bot, spotting denied or unknown commands, and seeing how long handlers take. Default 15; max 50.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(50, Math.max(1, parseInt(args[0] ?? "15", 10) || 15));
    const [stats, entries] = await Promise.all([
      getCommandHistoryStats(),
      getCommandHistory(n),
    ]);
    if (entries.length === 0) {
      await reply("No command history yet.");
      return { alreadyReplied: true };
    }
    const lines = [
      header("📝", `Command history (${entries.length})`),
      "",
      `<i>Total ${stats.total} · ok ${stats.ok} · denied ${stats.denied} · unknown ${stats.unknown} · error ${stats.error}</i>`,
      "",
    ];
    for (const e of entries) {
      const icon =
        e.outcome === "ok"
          ? "🟢"
          : e.outcome === "denied"
            ? "🚫"
            : e.outcome === "unknown"
              ? "❓"
              : "🔴";
      lines.push(
        `${icon} <code>/${esc(e.command)}</code> · ${esc(ago(e.at))} · ${e.durationMs}ms${e.error ? `\n   ${esc(e.error.slice(0, 100))}` : ""}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});
