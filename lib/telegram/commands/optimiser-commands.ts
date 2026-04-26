/**
 * Optimisation reads: /runs, /run, /queue, /schedules, /trials, /best,
 * /strategies, /strategy.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { listRuns, listTrials } from "@/lib/optimizer/repository";
import { listStrategies, getStrategy } from "@/lib/optimizer/strategies";
import { registerCommand } from "../registry";
import {
  ago,
  b,
  durationLabel,
  esc,
  header,
  kvList,
  num,
  signedPct,
  statusEmoji,
  truncate,
} from "../format";

// ── /runs [n] ────────────────────────────────────────────────────────────

registerCommand({
  name: "runs",
  usage: "/runs [n]",
  description: "Recent optimisation runs (default 8).",
  explanation:
    "Lists recent runs with status, algorithm, trial progress, and best composite score. The composite is the multi-objective score the optimizer ranks trials by — higher is better. Use /run <id> to drill into one. Default 8; max 25.",
  group: "read",
  async handler({ args, reply }) {
    const n = Math.min(25, Math.max(1, parseInt(args[0] ?? "8", 10) || 8));
    const rows = await listRuns(n);
    if (rows.length === 0) {
      await reply("No optimisation runs yet.");
      return { alreadyReplied: true };
    }
    const lines = [header("🧪", `Recent runs (${rows.length})`)];
    for (const r of rows) {
      const trials = `${num(r.nTrialsDone ?? 0)}/${num(r.nTrialsTarget)}`;
      lines.push(
        "",
        `${statusEmoji(r.status)} <b>${esc(r.name)}</b> · ${esc(r.searchAlgorithm)} · ${esc(r.status)}`,
        `<code>${esc(r.id)}</code>`,
        `trials ${trials} · ${esc(ago(r.createdAt))}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /run <id> ────────────────────────────────────────────────────────────

registerCommand({
  name: "run",
  usage: "/run <id>",
  description: "Single run detail: status, ETA, trials, top composite.",
  explanation:
    "Drills into one optimisation run. Shows status, who/what kicked it off, dataset filters, CV strategy, current trial count vs target, ETA for in-flight runs, best composite, and the top trial's headline metrics (ROI ± CI, Sharpe, drawdown). Pass a run id (full or prefix) — usually copied from /runs.",
  group: "read",
  async handler({ args, reply }) {
    if (args.length === 0) {
      await reply("Usage: /run &lt;id&gt;");
      return { alreadyReplied: true };
    }
    const idLike = `${args[0]}%`;
    const r = await db.execute(sql`
      SELECT * FROM optimization_runs WHERE id ILIKE ${idLike} LIMIT 1
    `);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await reply(`No run matches <code>${esc(args[0])}</code>.`);
      return { alreadyReplied: true };
    }
    const lines = [
      header("🧪", String(row.name ?? "—")),
      `<code>${esc(String(row.id))}</code>`,
      "",
      kvList([
        ["Status", `${statusEmoji(String(row.status))} ${row.status}`],
        ["Algorithm", String(row.search_algorithm)],
        ["Trials", `${row.n_trials_done ?? 0}/${row.n_trials_target}`],
        ["Created", esc(ago(String(row.created_at)))],
        ["Started", row.started_at ? esc(ago(String(row.started_at))) : "—"],
        [
          "Finished",
          row.completed_at ? esc(ago(String(row.completed_at))) : "—",
        ],
        ["Source", String(row.created_by ?? "manual")],
      ]),
    ];
    if (row.error) {
      lines.push("", b("Error"), esc(truncate(String(row.error), 300)));
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /queue ───────────────────────────────────────────────────────────────

registerCommand({
  name: "queue",
  usage: "/queue",
  description: "Optimisation runs currently queued (not yet started).",
  explanation:
    "Quick view of runs that are queued but haven't been claimed by the Cloud Run Job yet — usually because the previous run is still in flight. If something is stuck queued for >5 minutes the scheduler is likely down. Run <code>/optimise …</code> to add more, <code>/cancel id</code> to drop one.",
  group: "read",
  async handler({ reply }) {
    const r = await db.execute(sql`
      SELECT id, name, search_algorithm, n_trials_target, created_at, created_by
      FROM optimization_runs WHERE status='queued'
      ORDER BY created_at ASC LIMIT 30
    `);
    const rows = r.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      await reply("✅ Queue empty.");
      return { alreadyReplied: true };
    }
    const lines = [header("🟡", `Queued (${rows.length})`)];
    for (const row of rows) {
      lines.push(
        "",
        `<b>${esc(String(row.name))}</b> · ${esc(String(row.search_algorithm))} · ${row.n_trials_target} trials`,
        `<code>${esc(String(row.id))}</code> · queued ${esc(ago(String(row.created_at)))} · ${esc(String(row.created_by ?? "manual"))}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /schedules ───────────────────────────────────────────────────────────

registerCommand({
  name: "schedules",
  usage: "/schedules",
  description: "Recurring optimisation schedules (cron-style).",
  explanation:
    "Shows configured automatic sweep schedules: name, enabled state, next fire time, last fire time, and trial count target. Schedules are managed from /lab/optimisation in the web UI; this command is read-only here.",
  group: "read",
  async handler({ reply }) {
    const r = await db.execute(sql`
      SELECT id, name, enabled, next_fire_at, last_fire_at, n_trials_target, search_algorithm
      FROM optimization_schedules ORDER BY enabled DESC, next_fire_at ASC
    `);
    const rows = r.rows as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      await reply("No optimisation schedules configured.");
      return { alreadyReplied: true };
    }
    const lines = [header("⏰", `Schedules (${rows.length})`)];
    for (const row of rows) {
      const next = row.next_fire_at ? new Date(String(row.next_fire_at)) : null;
      const nextLabel = next
        ? next.getTime() > Date.now()
          ? `next in ${durationLabel(next.getTime() - Date.now())}`
          : `overdue by ${durationLabel(Date.now() - next.getTime())}`
        : "never";
      lines.push(
        "",
        `${row.enabled ? "🟢" : "⚪"} <b>${esc(String(row.name))}</b> · ${esc(String(row.search_algorithm))} · ${row.n_trials_target} trials`,
        `${esc(nextLabel)} · last ${row.last_fire_at ? esc(ago(String(row.last_fire_at))) : "never"}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /trials <runId> [n] ──────────────────────────────────────────────────

registerCommand({
  name: "trials",
  usage: "/trials <runId> [n]",
  description: "Top N trials for a run (default 5).",
  explanation:
    "Lists the top trials of a run by composite score (the multi-objective ranker), with their ROI, Sharpe, drawdown, and sample size. Pass the run id (or prefix) plus an optional limit. Useful to compare candidate parameter sets without opening the dashboard.",
  group: "read",
  async handler({ args, reply }) {
    if (args.length === 0) {
      await reply("Usage: /trials &lt;runId&gt; [n]");
      return { alreadyReplied: true };
    }
    const n = Math.min(15, Math.max(1, parseInt(args[1] ?? "5", 10) || 5));
    const idLike = `${args[0]}%`;
    const found = await db.execute(sql`
      SELECT id FROM optimization_runs WHERE id ILIKE ${idLike} LIMIT 1
    `);
    const runId = (found.rows[0] as { id?: string } | undefined)?.id;
    if (!runId) {
      await reply(`No run matches <code>${esc(args[0])}</code>.`);
      return { alreadyReplied: true };
    }
    const trials = await listTrials(runId, {
      limit: n,
      sortBy: "composite",
      sortDir: "desc",
    });
    if (trials.length === 0) {
      await reply("No trials yet for this run.");
      return { alreadyReplied: true };
    }
    const lines = [header("🏆", `Top ${trials.length} trials`)];
    for (const t of trials) {
      const ci =
        t.oosRoiCiLow != null && t.oosRoiCiHigh != null
          ? ` (CI ${signedPct(Number(t.oosRoiCiLow))}→${signedPct(Number(t.oosRoiCiHigh))})`
          : "";
      lines.push(
        "",
        `${t.onPareto ? "🌟" : "•"} <code>${esc(String(t.id))}</code>`,
        `composite ${t.compositeScore != null ? Number(t.compositeScore).toFixed(2) : "—"} · ROI ${t.oosRoiMean != null ? signedPct(Number(t.oosRoiMean)) : "—"}${esc(ci)}`,
        `Sharpe ${t.oosSharpe != null ? Number(t.oosSharpe).toFixed(2) : "—"} · DD ${t.maxDrawdown != null ? Math.abs(Number(t.maxDrawdown)).toFixed(1) + "%" : "—"} · n=${num(t.sampleSize ?? 0)}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /best ────────────────────────────────────────────────────────────────

registerCommand({
  name: "best",
  usage: "/best",
  description: "Single best optimisation trial across every run, ever.",
  explanation:
    "Pulls the trial with the highest composite score over the whole optimisation history. Useful to remember 'what was the best parameter set we ever found?' when comparing fresh runs against historical winners. Shows ROI, CI, Sharpe, sample size, and the run it came from.",
  group: "read",
  async handler({ reply }) {
    const r = await db.execute(sql`
      SELECT t.*, r.name AS run_name
      FROM optimization_trials t
      JOIN optimization_runs r ON r.id = t.run_id
      WHERE t.composite_score IS NOT NULL
      ORDER BY t.composite_score DESC
      LIMIT 1
    `);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      await reply("No completed trials yet.");
      return { alreadyReplied: true };
    }
    const lines = [
      header("🥇", "Best trial ever"),
      `<code>${esc(String(row.id))}</code> · run <b>${esc(String(row.run_name))}</b>`,
      "",
      kvList([
        ["Composite", Number(row.composite_score).toFixed(2)],
        [
          "ROI",
          row.oos_roi_mean != null ? signedPct(Number(row.oos_roi_mean)) : "—",
        ],
        [
          "Sharpe",
          row.oos_sharpe != null ? Number(row.oos_sharpe).toFixed(2) : "—",
        ],
        [
          "Sortino",
          row.oos_sortino != null ? Number(row.oos_sortino).toFixed(2) : "—",
        ],
        [
          "Max DD",
          row.max_drawdown != null
            ? Math.abs(Number(row.max_drawdown)).toFixed(1) + "%"
            : "—",
        ],
        ["Sample", num(Number(row.sample_size ?? 0))],
        [
          "DSR",
          row.deflated_sharpe != null
            ? Number(row.deflated_sharpe).toFixed(2)
            : "—",
        ],
        [
          "PSR",
          row.probabilistic_sharpe != null
            ? Number(row.probabilistic_sharpe).toFixed(2)
            : "—",
        ],
      ]),
    ];
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /strategies ──────────────────────────────────────────────────────────

registerCommand({
  name: "strategies",
  usage: "/strategies",
  description: "All promoted strategies (live + retired).",
  explanation:
    "Lists every strategy ever promoted from an optimiser trial. Live strategies (not retired) drive the auto-placer's filtering; retired ones are kept for audit. Shows name, status, source run, and creation date. Use the web UI to promote/un-retire — this command is read-only.",
  group: "read",
  async handler({ reply }) {
    const rows = await listStrategies();
    if (rows.length === 0) {
      await reply("No strategies yet. Promote a trial from /lab/optimisation.");
      return { alreadyReplied: true };
    }
    const lines = [header("🎛", `Strategies (${rows.length})`)];
    for (const s of rows) {
      lines.push(
        "",
        `${s.retiredAt ? "⚪" : "🟢"} <b>${esc(s.name)}</b>`,
        `<code>${esc(s.id)}</code> · ${s.retiredAt ? "retired" : "live"} · ${esc(ago(s.createdAt))}`,
      );
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});

// ── /strategy <id> ───────────────────────────────────────────────────────

registerCommand({
  name: "strategy",
  usage: "/strategy <id>",
  description: "Single strategy detail: filters, sizing, snapshot metrics.",
  explanation:
    "Drills into a single strategy. Shows the filter conditions it applies (EV cutoff, allowed books, allowed markets, odds range), the sizing scheme (Kelly fraction, cap), the metrics snapshot from when it was promoted, and live status. Use the web UI to edit filters/sizing — read-only here.",
  group: "read",
  async handler({ args, reply }) {
    if (args.length === 0) {
      await reply("Usage: /strategy &lt;id&gt;");
      return { alreadyReplied: true };
    }
    const all = await listStrategies();
    const found =
      all.find((s) => s.id === args[0]) ??
      all.find((s) => s.id.toLowerCase().startsWith(args[0].toLowerCase())) ??
      (await getStrategy(args[0]));
    if (!found) {
      await reply(`No strategy matches <code>${esc(args[0])}</code>.`);
      return { alreadyReplied: true };
    }
    const filters = found.filters as Record<string, unknown>;
    const sizing = found.sizing as Record<string, unknown>;
    const metrics = (found.metricsSnapshot ?? {}) as Record<string, unknown>;
    const filterRows: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(filters)) {
      filterRows.push([k, esc(JSON.stringify(v))]);
    }
    const lines = [
      header("🎛", esc(found.name)),
      `<code>${esc(found.id)}</code>`,
      `Status: ${found.retiredAt ? "⚪ retired" : "🟢 live"}`,
      "",
      b("Filters"),
      filterRows.length === 0 ? "<i>(none)</i>" : kvList(filterRows),
      "",
      b("Sizing"),
      kvList([
        ["Scheme", String(sizing.staking_scheme ?? "kelly")],
        ["Kelly fraction", String(sizing.kelly_fraction ?? "—")],
        ["Kelly cap %", String(sizing.kelly_cap_pct ?? "—")],
      ]),
      "",
      b("Metrics snapshot at promotion"),
      kvList([
        [
          "OOS ROI",
          metrics.oosRoiMean != null
            ? signedPct(Number(metrics.oosRoiMean))
            : "—",
        ],
        [
          "Sharpe",
          metrics.oosSharpe != null
            ? Number(metrics.oosSharpe).toFixed(2)
            : "—",
        ],
        [
          "Sample",
          metrics.sampleSize != null ? num(Number(metrics.sampleSize)) : "—",
        ],
      ]),
    ];
    if (found.description) {
      lines.push("", b("Description"), esc(found.description));
    }
    await reply(lines.join("\n"));
    return { alreadyReplied: true };
  },
});
