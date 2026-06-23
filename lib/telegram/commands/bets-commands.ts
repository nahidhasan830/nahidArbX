
import { sql } from "drizzle-orm";
import {
  addHours,
  hoursToMilliseconds,
  minutesToMilliseconds,
  subDays,
} from "date-fns";
import { db } from "@/lib/db/client";
import { listBettingProviders } from "@/lib/betting/registry";
import {
  getValueBets as storeGetValueBets,
  getEvents,
  getValueBetsByEvent,
} from "@/lib/store";
import { getProviderShortName } from "@/lib/providers/registry";
import { registerCommand } from "../registry";
import {
  ago,
  b,
  durationLabel,
  esc,
  header,
  i,
  kvList,
  money,
  num,
  pct,
  signedMoney,
  signedPct,
  truncate,
} from "../format";


registerCommand({
  name: "balance",
  usage: "/balance",
  description: "Live balance + exposure + suspended flag per book.",
  explanation:
    "Hits each betting adapter's getAccountInfo() to pull the live balance, current exposure, minimum bet, and suspended flag from the book. Currency comes from the adapter (NineWickets is BDT). If a book's API is down, it shows the error instead of fake numbers. Example: 'NineWickets-Sportsbook · BDT 84,200.00 · exposure 12,500.00 · min 50 · open'.",
  group: "read",
  async handler({ reply }) {
    const adapters = listBettingProviders();
    if (adapters.length === 0) {
      await reply("No betting providers configured.");
      return { alreadyReplied: true };
    }
    const lines = [header("💼", "Balances")];
    for (const a of adapters) {
      try {
        const info = await a.getAccountInfo();
        lines.push(
          "",
          b(a.providerDisplayName),
          kvList([
            ["Balance", money(info.balance, info.currency)],
            ["Exposure", money(info.exposure, info.currency)],
            ["Min bet", money(info.minBet, info.currency)],
            ["Status", info.suspended ? "🔴 suspended" : "🟢 open"],
          ]),
        );
      } catch (err) {
        lines.push(
          "",
          b(a.providerDisplayName),
          `⚠️ ${esc((err as Error).message)}`,
        );
      }
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "today",
  usage: "/today",
  description: "Today's bets: placed, won, lost, P&L, ROI, open exposure.",
  explanation:
    "One-shot summary of the trading day starting at local midnight: how many bets you placed, how many settled, the won/lost/void split, real-money P&L, ROI on staked-and-settled bets, and how much is still in play. Skips detected-but-not-placed value bets — this is your bookkeeping view, not the opportunity feed.",
  group: "read",
  async handler({ reply }) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startIso = start.toISOString();
    try {
      const r = await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE placed_at >= ${startIso})::int AS placed,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome IN ('won','lost','void','half_won','half_lost'))::int AS settled,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'won')::int AS won,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'lost')::int AS lost,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'void')::int AS void,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'half_won')::int AS hwon,
          COUNT(*) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'half_lost')::int AS hlost,
          COALESCE(SUM(stake) FILTER (WHERE placed_at >= ${startIso} AND outcome IN ('won','lost','void','half_won','half_lost')), 0)::float AS settled_stake,
          COALESCE(SUM(pnl)   FILTER (WHERE placed_at >= ${startIso} AND outcome IN ('won','lost','void','half_won','half_lost')), 0)::float AS pnl,
          COALESCE(SUM(stake) FILTER (WHERE placed_at >= ${startIso} AND outcome = 'pending'), 0)::float AS open_stake
        FROM bets
        WHERE placed_at IS NOT NULL
      `);
      const row = (r.rows[0] ?? {}) as Record<string, number>;
      const settledStake = Number(row.settled_stake ?? 0);
      const pnl = Number(row.pnl ?? 0);
      const roi = settledStake > 0 ? (pnl / settledStake) * 100 : NaN;
      const settled = Number(row.settled ?? 0);
      const won = Number(row.won ?? 0);
      const winRate = settled > 0 ? (won / settled) * 100 : NaN;
      const lines = [
        header("📅", "Today"),
        "",
        kvList([
          ["Placed", num(Number(row.placed ?? 0))],
          ["Settled", num(settled)],
          ["Won / Lost / Void", `${won} / ${row.lost ?? 0} / ${row.void ?? 0}`],
          ["Half won / half lost", `${row.hwon ?? 0} / ${row.hlost ?? 0}`],
          ["Win rate", pct(winRate)],
          ["P&L", signedMoney(pnl)],
          ["ROI", signedPct(roi)],
          ["Open exposure", money(Number(row.open_stake ?? 0))],
        ]),
      ];
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "pnl",
  usage: "/pnl [days]",
  description: "P&L + ROI over the last N days (default 7).",
  explanation:
    "Aggregates real-money P&L for placed-and-settled bets in the requested rolling window. ROI is P&L divided by total settled stake. Use this to answer 'has the system actually made money this week?'. Default is 7 days; pass any positive integer (e.g. /pnl 30 for last month).",
  group: "read",
  async handler({ args, reply }) {
    const days = Math.min(365, Math.max(1, parseInt(args[0] ?? "7", 10) || 7));
    const since = subDays(new Date(), days).toISOString();
    try {
      const r = await db.execute(sql`
        SELECT
          COUNT(*)::int AS settled,
          COUNT(*) FILTER (WHERE outcome = 'won')::int AS won,
          COALESCE(SUM(stake), 0)::float AS stake,
          COALESCE(SUM(pnl), 0)::float AS pnl
        FROM bets
        WHERE placed_at IS NOT NULL
          AND placed_at >= ${since}::timestamptz
          AND outcome IN ('won','lost','void','half_won','half_lost')
      `);
      const row = (r.rows[0] ?? {}) as Record<string, number>;
      const stake = Number(row.stake ?? 0);
      const pnl = Number(row.pnl ?? 0);
      const settled = Number(row.settled ?? 0);
      const won = Number(row.won ?? 0);
      const roi = stake > 0 ? (pnl / stake) * 100 : NaN;
      const winRate = settled > 0 ? (won / settled) * 100 : NaN;
      const lines = [
        header("📈", `P&L · last ${days}d`),
        "",
        kvList([
          ["Settled bets", num(settled)],
          ["Win rate", pct(winRate)],
          ["Stake", money(stake)],
          ["P&L", signedMoney(pnl)],
          ["ROI", signedPct(roi)],
        ]),
      ];
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "value",
  usage: "/value [n]",
  description: "Top N current value bets (default 10).",
  explanation:
    "Top-of-the-feed snapshot — the highest-EV opportunities currently detected, in EV order. Pulls from the in-memory value-bets store (refreshed by every odds sync). Each line shows event, market+selection, the soft book, soft price, EV%, and recommended Kelly stake. Default 10; max 25.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(25, Math.max(1, parseInt(args[0] ?? "10", 10) || 10));
    const all = storeGetValueBets();
    if (all.length === 0) {
      await reply("No value bets right now.");
      return { alreadyReplied: true };
    }
    const events = new Map<string, ReturnType<typeof getEvents>[number]>();
    for (const e of getEvents()) events.set(e.id, e);
    const lines = [header("🎯", `Top ${Math.min(n, all.length)} value bets`)];
    for (const v of all.slice(0, n)) {
      const ev = events.get(v.eventId);
      const matchup = ev ? `${ev.homeTeam} vs ${ev.awayTeam}` : v.eventId;
      lines.push(
        "",
        `<b>${esc(matchup)}</b> ${i(ev?.competition ?? "")}`.trim(),
        `${esc(v.atomId)} · ${esc(getProviderShortName(v.softProvider))} ${esc(v.softOdds.toFixed(2))} · EV ${signedPct(v.evPct)} · Kelly ${money(v.kellyStake)}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "recent",
  usage: "/recent [n]",
  description: "Last N placed bets with status.",
  explanation:
    "Tail of placed bets in reverse chronological order. Each line shows event, market, stake @ odds, current outcome (pending / won / lost / void / half), and how long ago it was placed. Default 10. Useful right after a sync to confirm new auto-placements landed.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(25, Math.max(1, parseInt(args[0] ?? "10", 10) || 10));
    try {
      const r = await db.execute(sql`
        SELECT id, home_team, away_team, market_type, atom_label, stake, odds,
               outcome, pnl, placed_at, soft_provider
        FROM bets WHERE placed_at IS NOT NULL
        ORDER BY placed_at DESC LIMIT ${n}
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply("No placed bets yet.");
        return { alreadyReplied: true };
      }
      const lines = [header("🧾", `Last ${rows.length} placed`)];
      for (const row of rows) {
        const stake = Number(row.stake ?? 0);
        const odds = Number(row.odds ?? 0);
        const pnl = row.pnl != null ? Number(row.pnl) : null;
        const outcome = String(row.outcome ?? "?");
        const emoji =
          outcome === "won"
            ? "🟢"
            : outcome === "lost"
              ? "🔴"
              : outcome === "void"
                ? "⚪"
                : outcome === "half_won"
                  ? "🟡"
                  : outcome === "half_lost"
                    ? "🟠"
                    : "🟦";
        const matchup = `${esc(String(row.home_team))} vs ${esc(String(row.away_team))}`;
        const placedAgo = ago(String(row.placed_at));
        const pnlStr = pnl != null ? signedMoney(pnl) : "—";
        lines.push(
          "",
          `${emoji} <b>${matchup}</b> · ${i(String(row.market_type))} → ${esc(String(row.atom_label))}`,
          `${money(stake)} @ ${odds.toFixed(2)} · ${esc(outcome)} · pnl ${pnlStr} · ${esc(placedAgo)}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "pending",
  usage: "/pending",
  description: "Placed bets still pending settlement (open positions).",
  explanation:
    "Lists every bet you've placed that hasn't settled yet. Each row shows event, kickoff time relative to now, market, stake, and odds. Bets whose kickoff is more than 2h15m in the past appear with a ⚠️ — those are 'ready to settle' but the pipeline hasn't resolved them yet.",
  group: "read",
  async handler({ reply }) {
    try {
      const r = await db.execute(sql`
        SELECT id, home_team, away_team, market_type, atom_label, stake, odds,
               event_start_time, settle_attempts
        FROM bets WHERE placed_at IS NOT NULL AND outcome = 'pending'
        ORDER BY event_start_time ASC LIMIT 30
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply("✅ No pending placed bets.");
        return { alreadyReplied: true };
      }
      const now = Date.now();
      const lines = [header("⏳", `Pending placed bets (${rows.length})`)];
      for (const row of rows) {
        const startMs = new Date(String(row.event_start_time)).getTime();
        const diff = startMs - now;
        const staleStartedThresholdMs =
          hoursToMilliseconds(2) + minutesToMilliseconds(15);
        const when =
          diff > 0
            ? `kicks off in ${durationLabel(diff)}`
            : Math.abs(diff) > staleStartedThresholdMs
              ? `⚠️ started ${durationLabel(-diff)} ago`
              : `started ${durationLabel(-diff)} ago`;
        lines.push(
          "",
          `<b>${esc(String(row.home_team))} vs ${esc(String(row.away_team))}</b>`,
          `${i(String(row.market_type))} → ${esc(String(row.atom_label))} · ${money(Number(row.stake))} @ ${Number(row.odds).toFixed(2)}`,
          `${when} · attempts ${row.settle_attempts ?? 0}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "exposure",
  usage: "/exposure",
  description: "Open exposure broken down by event & market.",
  explanation:
    "Shows where your stake is currently sitting. Groups every pending placed bet by event and lists each market+selection along with stake at risk. The total at the top is your live drawdown surface — if every open bet lost, that's what you'd lose. Doesn't include detected-but-not-placed value bets.",
  group: "read",
  async handler({ reply }) {
    try {
      const r = await db.execute(sql`
        SELECT home_team, away_team, market_type, atom_label, stake, odds, soft_provider
        FROM bets WHERE placed_at IS NOT NULL AND outcome = 'pending'
        ORDER BY home_team, market_type
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply("✅ No open exposure.");
        return { alreadyReplied: true };
      }
      const total = rows.reduce((s, r) => s + Number(r.stake ?? 0), 0);
      const lines = [
        header("🎚", "Open exposure"),
        `${b("Total at risk")}: ${money(total)} · ${num(rows.length)} bets`,
        "",
      ];
      let lastMatch = "";
      for (const row of rows) {
        const matchup = `${row.home_team} vs ${row.away_team}`;
        if (matchup !== lastMatch) {
          lines.push(`<b>${esc(matchup)}</b>`);
          lastMatch = matchup;
        }
        lines.push(
          `  ${i(String(row.market_type))} → ${esc(String(row.atom_label))} · ${money(Number(row.stake))} @ ${Number(row.odds).toFixed(2)} · ${esc(getProviderShortName(String(row.soft_provider)))}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "now",
  usage: "/now",
  description: "Live events with bets currently in play.",
  explanation:
    "Filters open exposure to only events that have already kicked off but haven't yet finished (started within the last 3 hours). Most of the time this is what you actually want to watch on your phone — the bets that are live right now.",
  group: "read",
  async handler({ reply }) {
    try {
      const r = await db.execute(sql`
        SELECT home_team, away_team, market_type, atom_label, stake, odds, event_start_time
        FROM bets WHERE placed_at IS NOT NULL AND outcome = 'pending'
          AND event_start_time <= NOW()
          AND event_start_time > NOW() - INTERVAL '3 hours'
        ORDER BY event_start_time DESC
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply("⚪ No bets currently live.");
        return { alreadyReplied: true };
      }
      const lines = [header("🔴", `Live · ${rows.length} bets in play`)];
      for (const row of rows) {
        const since = ago(String(row.event_start_time));
        lines.push(
          "",
          `<b>${esc(String(row.home_team))} vs ${esc(String(row.away_team))}</b>`,
          `${i(String(row.market_type))} → ${esc(String(row.atom_label))} · ${money(Number(row.stake))} @ ${Number(row.odds).toFixed(2)} · started ${esc(since)}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "upcoming",
  usage: "/upcoming [hours]",
  description: "Value bets on events kicking off in next N hours (default 6).",
  explanation:
    "Filters the live value-bet feed to only events kicking off within the requested window — the realistic 'what's actionable right now' view. Default 6 hours; pass any positive integer. Each line shows kickoff time, event, market, EV%, and Kelly stake.",
  group: "read",
  async handler({ args, reply }) {
    const hours = Math.min(72, Math.max(1, parseInt(args[0] ?? "6", 10) || 6));
    const cutoffMs = addHours(new Date(), hours).getTime();
    const grouped = getValueBetsByEvent();
    const events = new Map<string, ReturnType<typeof getEvents>[number]>();
    for (const e of getEvents()) events.set(e.id, e);
    const lines = [header("📅", `Upcoming · next ${hours}h`)];
    let count = 0;
    for (const [eventId, vbs] of grouped.entries()) {
      const ev = events.get(eventId);
      if (!ev) continue;
      const start = ev.startTime.getTime();
      if (start <= Date.now() || start > cutoffMs) continue;
      vbs.sort((a, b) => b.evPct - a.evPct);
      lines.push(
        "",
        `<b>${esc(ev.homeTeam)} vs ${esc(ev.awayTeam)}</b> · ${i(durationLabel(start - Date.now()) + " away")}`,
      );
      for (const v of vbs.slice(0, 3)) {
        lines.push(
          `  ${esc(v.atomId)} · ${esc(getProviderShortName(v.softProvider))} ${v.softOdds.toFixed(2)} · EV ${signedPct(v.evPct)} · Kelly ${money(v.kellyStake)}`,
        );
      }
      count += 1;
    }
    if (count === 0) lines.push("", `<i>No value bets in next ${hours}h.</i>`);
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "clv",
  usage: "/clv [days]",
  description: "Closing line value over last N days (default 30).",
  explanation:
    "Closing line value is the gold-standard 'am I actually beating the market' signal — positive average CLV means you took prices the sharp closing line later contracted past. Computed as (your-odds / closing-soft-odds − 1) × 100, averaged across all placed bets in the window with closing-odds captured.",
  group: "read",
  async handler({ args, reply }) {
    const days = Math.min(
      365,
      Math.max(1, parseInt(args[0] ?? "30", 10) || 30),
    );
    const since = subDays(new Date(), days).toISOString();
    try {
      const r = await db.execute(sql`
        SELECT
          COUNT(*)::int AS n,
          AVG(clv_pct)::float AS avg_clv,
          COUNT(*) FILTER (WHERE clv_pct > 0)::int AS positive
        FROM bets
        WHERE placed_at IS NOT NULL
          AND placed_at >= ${since}::timestamptz
          AND clv_pct IS NOT NULL
      `);
      const row = (r.rows[0] ?? {}) as Record<string, number>;
      const n = Number(row.n ?? 0);
      if (n === 0) {
        await reply(
          `No closing-line data captured in the last ${days}d. Closing odds are snapshotted automatically a few minutes before kickoff — stale rows or feeds being down explain a zero count.`,
        );
        return { alreadyReplied: true };
      }
      const avg = Number(row.avg_clv ?? 0);
      const pos = Number(row.positive ?? 0);
      const lines = [
        header("🎯", `CLV · last ${days}d`),
        "",
        kvList([
          ["Bets w/ closing", num(n)],
          ["Avg CLV", signedPct(avg)],
          ["Positive CLV rate", pct(n > 0 ? (pos / n) * 100 : 0)],
        ]),
      ];
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "byprovider",
  usage: "/byprovider [days]",
  description: "P&L / ROI / win-rate per soft book (default 30 days).",
  explanation:
    "Slices placed-and-settled bets in the requested window by soft provider so you can see which book is making money and which one is leaking it. Useful when /pnl looks fine overall but you suspect one book is dragging the rest. Window default 30 days.",
  group: "read",
  async handler({ args, reply }) {
    const days = Math.min(
      365,
      Math.max(1, parseInt(args[0] ?? "30", 10) || 30),
    );
    const since = subDays(new Date(), days).toISOString();
    try {
      const r = await db.execute(sql`
        SELECT soft_provider AS prov,
               COUNT(*)::int AS n,
               COUNT(*) FILTER (WHERE outcome='won')::int AS won,
               COALESCE(SUM(stake),0)::float AS stake,
               COALESCE(SUM(pnl),0)::float AS pnl
        FROM bets
        WHERE placed_at IS NOT NULL
          AND placed_at >= ${since}::timestamptz
          AND outcome IN ('won','lost','void','half_won','half_lost')
        GROUP BY soft_provider
        ORDER BY pnl DESC
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply(`No settled placed bets in last ${days}d.`);
        return { alreadyReplied: true };
      }
      const lines = [header("🏦", `By provider · last ${days}d`)];
      for (const row of rows) {
        const stake = Number(row.stake ?? 0);
        const pnl = Number(row.pnl ?? 0);
        const n = Number(row.n ?? 0);
        const won = Number(row.won ?? 0);
        const roi = stake > 0 ? (pnl / stake) * 100 : NaN;
        lines.push(
          "",
          `<b>${esc(getProviderShortName(String(row.prov ?? "—")))}</b> · ${num(n)} bets`,
          `  P&L ${signedMoney(pnl)} · ROI ${signedPct(roi)} · WR ${pct(n > 0 ? (won / n) * 100 : NaN)}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "bymarket",
  usage: "/bymarket [days]",
  description: "P&L / ROI per market type (default 30 days).",
  explanation:
    "Same shape as /byprovider but sliced by market type — Match Odds vs Over/Under vs Asian Handicap vs BTTS, etc. Use this to spot 'I'm crushing 1X2 but bleeding on totals' patterns. Window default 30 days.",
  group: "read",
  async handler({ args, reply }) {
    const days = Math.min(
      365,
      Math.max(1, parseInt(args[0] ?? "30", 10) || 30),
    );
    const since = subDays(new Date(), days).toISOString();
    try {
      const r = await db.execute(sql`
        SELECT market_type AS m,
               COUNT(*)::int AS n,
               COALESCE(SUM(stake),0)::float AS stake,
               COALESCE(SUM(pnl),0)::float AS pnl,
               COUNT(*) FILTER (WHERE outcome='won')::int AS won
        FROM bets
        WHERE placed_at IS NOT NULL
          AND placed_at >= ${since}::timestamptz
          AND outcome IN ('won','lost','void','half_won','half_lost')
        GROUP BY market_type
        ORDER BY pnl DESC
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply(`No settled placed bets in last ${days}d.`);
        return { alreadyReplied: true };
      }
      const lines = [header("🎲", `By market · last ${days}d`)];
      for (const row of rows) {
        const stake = Number(row.stake ?? 0);
        const pnl = Number(row.pnl ?? 0);
        const n = Number(row.n ?? 0);
        const won = Number(row.won ?? 0);
        const roi = stake > 0 ? (pnl / stake) * 100 : NaN;
        lines.push(
          "",
          `<b>${esc(String(row.m ?? "—"))}</b> · ${num(n)} bets`,
          `  P&L ${signedMoney(pnl)} · ROI ${signedPct(roi)} · WR ${pct(n > 0 ? (won / n) * 100 : NaN)}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "calibration",
  usage: "/calibration [days]",
  description: "Predicted probability vs actual win rate, in 10% buckets.",
  explanation:
    "Buckets every settled placed bet by its predicted probability (sharp_true_prob) into deciles, then shows what actually happened. A well-calibrated system has 50%-bucket bets winning ~50% of the time, 70%-bucket ~70%, etc. Persistent gaps mean the EV calculation is biased — a useful sanity check on whether the edge is real.",
  group: "read",
  async handler({ args, reply }) {
    const days = Math.min(
      365,
      Math.max(1, parseInt(args[0] ?? "60", 10) || 60),
    );
    const since = subDays(new Date(), days).toISOString();
    try {
      const r = await db.execute(sql`
        SELECT FLOOR(sharp_true_prob * 10)::int AS bucket,
               COUNT(*)::int AS n,
               AVG(sharp_true_prob)::float AS avg_pred,
               AVG(CASE WHEN outcome='won' THEN 1 WHEN outcome='half_won' THEN 0.5 WHEN outcome='half_lost' THEN 0 ELSE 0 END)::float AS realized
        FROM bets
        WHERE placed_at IS NOT NULL
          AND placed_at >= ${since}::timestamptz
          AND outcome IN ('won','lost','void','half_won','half_lost')
        GROUP BY bucket
        ORDER BY bucket ASC
      `);
      const rows = r.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) {
        await reply(`No settled placed bets in last ${days}d.`);
        return { alreadyReplied: true };
      }
      const lines = [header("🎚", `Calibration · last ${days}d`)];
      for (const row of rows) {
        const pred = Number(row.avg_pred ?? 0) * 100;
        const actual = Number(row.realized ?? 0) * 100;
        const delta = actual - pred;
        const arrow = delta > 1 ? "🟢" : delta < -1 ? "🔴" : "⚪";
        lines.push(
          `${arrow} bucket ${row.bucket}0–${Number(row.bucket) + 1}0%: pred ${pct(pred)} · actual ${pct(actual)} · n=${row.n}`,
        );
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "streak",
  usage: "/streak",
  description: "Current win/loss streak + longest in last 30 days.",
  explanation:
    "Walks settled placed bets in reverse chronological order to detect the current run (consecutive wins or consecutive losses, treating void as neutral) and reports the longest run in the last 30 days. Use this to gut-check whether a rough day is statistically routine or a real warning sign.",
  group: "read",
  async handler({ reply }) {
    try {
      const r = await db.execute(sql`
        SELECT outcome, settled_at
        FROM bets
        WHERE placed_at IS NOT NULL
          AND outcome IN ('won','lost','void','half_won','half_lost')
          AND placed_at >= NOW() - INTERVAL '30 days'
        ORDER BY settled_at DESC NULLS LAST
        LIMIT 500
      `);
      const rows = r.rows as Array<{ outcome: string }>;
      if (rows.length === 0) {
        await reply("No settled placed bets in last 30d.");
        return { alreadyReplied: true };
      }
      const isWin = (o: string) => o === "won" || o === "half_won";
      const isLoss = (o: string) => o === "lost" || o === "half_lost";
      let curKind: "W" | "L" | null = null;
      let curLen = 0;
      for (const row of rows) {
        if (isWin(row.outcome)) {
          if (curKind === "W") {
            curLen += 1;
          } else if (curKind === null) {
            curKind = "W";
            curLen = 1;
          } else break;
        } else if (isLoss(row.outcome)) {
          if (curKind === "L") {
            curLen += 1;
          } else if (curKind === null) {
            curKind = "L";
            curLen = 1;
          } else break;
        }
      }
      let longestW = 0,
        longestL = 0,
        runW = 0,
        runL = 0;
      for (const row of rows) {
        if (isWin(row.outcome)) {
          runW += 1;
          runL = 0;
          if (runW > longestW) longestW = runW;
        } else if (isLoss(row.outcome)) {
          runL += 1;
          runW = 0;
          if (runL > longestL) longestL = runL;
        }
      }
      const lines = [
        header("🔥", "Streak"),
        "",
        kvList([
          [
            "Current",
            curKind === "W"
              ? `🟢 ${curLen} won in a row`
              : curKind === "L"
                ? `🔴 ${curLen} lost in a row`
                : "—",
          ],
          ["Longest win streak (30d)", `${longestW} bets`],
          ["Longest loss streak (30d)", `${longestL} bets`],
        ]),
      ];
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


const buildExtremes = (kind: "wins" | "losses") =>
  registerCommand({
    name: kind,
    usage: `/${kind} [n]`,
    description:
      kind === "wins"
        ? "Biggest N wins in last 30 days (default 5)."
        : "Biggest N losses in last 30 days (default 5).",
    explanation:
      kind === "wins"
        ? "Top N largest single-bet P&L hits — useful for posting screenshots and remembering which markets paid the rent. Default 5; max 15."
        : "Top N worst single-bet P&L hits — tilt audit. Use this to check whether losses are concentrated in one market or book (sometimes it's a leaky strategy you should retire).",
    group: "read",
    async handler({ args, reply }) {
      const n = Math.min(15, Math.max(1, parseInt(args[0] ?? "5", 10) || 5));
      const order = kind === "wins" ? sql`DESC` : sql`ASC`;
      try {
        const r = await db.execute(sql`
          SELECT home_team, away_team, market_type, atom_label, stake, odds, pnl, settled_at, soft_provider
          FROM bets
          WHERE placed_at IS NOT NULL
            AND placed_at >= NOW() - INTERVAL '30 days'
            AND outcome IN ('won','lost','half_won','half_lost')
          ORDER BY pnl ${order} NULLS LAST
          LIMIT ${n}
        `);
        const rows = r.rows as Array<Record<string, unknown>>;
        if (rows.length === 0) {
          await reply(`No ${kind} in last 30d.`);
          return { alreadyReplied: true };
        }
        const lines = [
          header(
            kind === "wins" ? "🏆" : "😬",
            `${kind === "wins" ? "Top" : "Worst"} ${rows.length}`,
          ),
        ];
        for (const row of rows) {
          lines.push(
            "",
            `<b>${esc(String(row.home_team))} vs ${esc(String(row.away_team))}</b>`,
            `${i(String(row.market_type))} → ${esc(String(row.atom_label))} · ${money(Number(row.stake))} @ ${Number(row.odds).toFixed(2)} · ${esc(getProviderShortName(String(row.soft_provider)))}`,
            `${signedMoney(Number(row.pnl ?? 0))} · ${esc(ago(String(row.settled_at)))}`,
          );
        }
        await reply(lines.join("\n"));
      } catch (err) {
        await reply(`⚠️ ${esc((err as Error).message)}`);
      }
      return { alreadyReplied: true };
    },
  });

buildExtremes("wins");
buildExtremes("losses");


registerCommand({
  name: "bet",
  usage: "/bet <id>",
  description: "Full detail on one bet by id.",
  explanation:
    "Pulls a single bet row and dumps every field that matters: event, market, soft + sharp odds, EV%, Kelly, placement details, settlement source, ticket id, P&L, CLV. Pass a partial id (prefix match) and the first hit wins. Use after /recent or /pending to drill into a specific row.",
  group: "read",
  async handler({ args, reply }) {
    if (args.length === 0) {
      await reply("Usage: /bet &lt;id&gt; (id from /recent or /pending)");
      return { alreadyReplied: true };
    }
    const idLike = `${args[0]}%`;
    try {
      const r = await db.execute(sql`
        SELECT * FROM bets WHERE id ILIKE ${idLike} LIMIT 1
      `);
      const row = r.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await reply(`No bet matches <code>${esc(args[0])}</code>.`);
        return { alreadyReplied: true };
      }
      const lines = [
        header("🔎", "Bet detail"),
        `<code>${esc(String(row.id))}</code>`,
        "",
        `<b>${esc(String(row.home_team))} vs ${esc(String(row.away_team))}</b>`,
        i(String(row.competition ?? "")),
        "",
        kvList([
          ["Market", `${row.market_type} → ${row.atom_label}`],
          [
            "Soft",
            `${getProviderShortName(String(row.soft_provider))} @ ${Number(row.soft_odds).toFixed(2)}`,
          ],
          [
            "Sharp",
            `${getProviderShortName(String(row.sharp_provider))} @ ${Number(row.sharp_odds).toFixed(2)} (p=${pct(Number(row.sharp_true_prob) * 100)})`,
          ],
          ["Outcome", String(row.outcome ?? "—")],
        ]),
      ];
      if (row.placed_at) {
        lines.push(
          "",
          b("Placed"),
          kvList([
            ["When", esc(ago(String(row.placed_at)))],
            [
              "Stake @ odds",
              `${money(Number(row.stake), String(row.currency ?? "BDT"))} @ ${Number(row.odds).toFixed(2)}`,
            ],
            ["Mode", String(row.mode ?? "—")],
            [
              "Ticket",
              row.provider_ticket_id ? String(row.provider_ticket_id) : "—",
            ],
          ]),
        );
      }
      if (row.outcome && row.outcome !== "pending") {
        lines.push(
          "",
          b("Settled"),
          kvList([
            ["When", row.settled_at ? esc(ago(String(row.settled_at))) : "—"],
            ["Source", String(row.settled_by_source ?? "—")],
            ["P&L", row.pnl != null ? signedMoney(Number(row.pnl)) : "—"],
            ["CLV", row.clv_pct != null ? signedPct(Number(row.clv_pct)) : "—"],
          ]),
        );
      }
      if (row.error) {
        lines.push("", b("Error"), esc(truncate(String(row.error), 300)));
      }
      await reply(lines.join("\n"));
    } catch (err) {
      await reply(`⚠️ ${esc((err as Error).message)}`);
    }
    return { alreadyReplied: true };
  },
});


registerCommand({
  name: "event",
  usage: "/event <query>",
  description: "Search events by team or competition; show value bets.",
  explanation:
    "Free-text search the in-memory matched-events store by home/away team or competition name (case-insensitive substring). For each hit, lists current value bets on that event so you can pull up 'what's on Liverpool right now' from the kitchen. Up to 5 matching events.",
  group: "read",
  async handler({ argsRaw, reply }) {
    const q = argsRaw.toLowerCase().trim();
    if (!q) {
      await reply("Usage: /event &lt;team or competition&gt;");
      return { alreadyReplied: true };
    }
    const events = getEvents().filter(
      (e) =>
        e.homeTeam.toLowerCase().includes(q) ||
        e.awayTeam.toLowerCase().includes(q) ||
        (e.competition ?? "").toLowerCase().includes(q),
    );
    if (events.length === 0) {
      await reply(`No events match <code>${esc(argsRaw)}</code>.`);
      return { alreadyReplied: true };
    }
    const grouped = getValueBetsByEvent();
    const lines = [header("🔍", `${events.length} event(s) match`)];
    for (const ev of events.slice(0, 5)) {
      lines.push(
        "",
        `<b>${esc(ev.homeTeam)} vs ${esc(ev.awayTeam)}</b> · ${i(ev.competition ?? "")}`,
        `<i>${esc(ago(ev.startTime))}</i> · providers ${esc(Object.keys(ev.providers).join(", "))}`,
      );
      const vbs = grouped.get(ev.id) ?? [];
      vbs.sort((a, b) => b.evPct - a.evPct);
      for (const v of vbs.slice(0, 3)) {
        lines.push(
          `  ${esc(v.atomId)} · ${esc(getProviderShortName(v.softProvider))} ${v.softOdds.toFixed(2)} · EV ${signedPct(v.evPct)}`,
        );
      }
      if (vbs.length === 0) lines.push(`  <i>No value bets right now.</i>`);
    }
    if (events.length > 5)
      lines.push("", `<i>+${events.length - 5} more — narrow the search.</i>`);
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});
