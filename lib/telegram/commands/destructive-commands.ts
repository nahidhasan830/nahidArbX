/**
 * Destructive commands — every one of these has a confirm-tap flow.
 *   /cancel <runId>, /retire <strategyId>, /optimise <name> <trials> [...kwargs],
 *   /place <valueBetId> [stake], /mark <betId> <outcome>, /delete <betId>,
 *   /promote <trialId> <name...>.
 */

import { cancelRun, createRun } from "@/lib/optimizer/repository";
import { kickRunNow } from "@/lib/optimizer/scheduler";
import {
  promoteStrategy,
  retireStrategy,
  type StrategyFilters,
  type StrategySizing,
} from "@/lib/optimizer/strategies";
import {
  applySettlement,
  deleteBet,
  getBetById,
  markOutcome,
} from "@/lib/db/repositories/bets";
import { placeBetForValueBet } from "@/lib/betting/placer";
import { getValueBets as storeGetValueBets } from "@/lib/store";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { optimizationTrials } from "@/lib/db/schema";
import { setAutoPlaceEnabled } from "@/lib/betting/auto-place-config";
import { listBettingProviders } from "@/lib/betting/registry";
import { createConfirm } from "../confirm";
import { registerCommand } from "../registry";
import { b, esc, kvList, money, signedPct } from "../format";

// ── /cancel <runId> ──────────────────────────────────────────────────────

registerCommand({
  name: "cancel",
  usage: "/cancel <runId>",
  description: "Cancel a queued or running optimisation sweep.",
  explanation:
    "Sets the run's status to 'cancelled' in Postgres. A running Cloud Run Job notices within 2 seconds (the runner polls the cancel flag) and exits cleanly. " +
    "Saves GCP minutes if you realise you submitted a bad config. Idempotent — cancelling an already-cancelled run is a no-op. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length === 0) {
      await reply("Usage: /cancel &lt;runId&gt;");
      return { alreadyReplied: true };
    }
    const runId = args[0];
    const description = `Cancel optimisation run <code>${esc(runId)}</code>`;
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        const ok = await cancelRun(runId);
        return ok
          ? `⏹ Cancelled run <code>${esc(runId)}</code>. The Cloud Run Job will exit within 2s.`
          : `⚠️ Run <code>${esc(runId)}</code> not in a cancellable state (already finished or unknown id).`;
      },
    });
    await reply(`⚠️ ${b("Confirm cancel")}\n${description}`, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /retire <strategyId> ─────────────────────────────────────────────────

registerCommand({
  name: "retire",
  usage: "/retire <strategyId>",
  description: "Retire a live strategy (auto-placer stops using it).",
  explanation:
    "Marks a strategy retired so the auto-placer no longer considers it. The strategy row stays in the DB with a retiredAt timestamp — " +
    "use the web UI to un-retire if you change your mind. Use this from the phone as a kill-switch when a live strategy starts losing money. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length === 0) {
      await reply("Usage: /retire &lt;strategyId&gt;");
      return { alreadyReplied: true };
    }
    const id = args[0];
    const description = `Retire strategy <code>${esc(id)}</code>`;
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        const row = await retireStrategy(id);
        return row
          ? `⚪ Retired strategy <b>${esc(row.name)}</b>.`
          : `⚠️ No strategy matches <code>${esc(id)}</code>.`;
      },
    });
    await reply(`⚠️ ${b("Confirm retire")}\n${description}`, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /optimise <name> <trials> [kwargs] ───────────────────────────────────

interface ParsedKwargs {
  positional: string[];
  kv: Record<string, string>;
}

function parseKwargs(args: string[]): ParsedKwargs {
  const positional: string[] = [];
  const kv: Record<string, string> = {};
  for (const a of args) {
    const eq = a.indexOf("=");
    if (eq > 0) {
      kv[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { positional, kv };
}

const ALGORITHMS = new Set([
  "random",
  "tpe",
  "nsga2",
  "ensemble",
  "ml-xgboost",
]);

registerCommand({
  name: "optimise",
  usage: "/optimise <name> <trials> [kwargs…]",
  description: "Queue a custom optimisation sweep.",
  explanation:
    "Creates an optimisation run with the parameters you pass and kicks the Cloud Run Job. The first two positional args are name and trials. " +
    "Everything else is keyword form: " +
    "<code>algo</code> (random|tpe|nsga2|ensemble|ml-xgboost), " +
    "<code>cv</code> (cpcv|walkforward), <code>groups</code>, <code>test</code>, <code>embargo</code>, " +
    "<code>from</code> / <code>to</code> (event-start window, YYYY-MM-DD), " +
    "<code>books</code> (comma-separated soft providers to include), " +
    "<code>markets</code> (comma-separated market types to include), " +
    "<code>placed=true</code> (only consider placed bets), " +
    "<code>seed</code>. Search-space dimensions stay web-only. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length < 2) {
      await reply(
        "Usage: /optimise &lt;name&gt; &lt;trials&gt; [algo=tpe ...]",
      );
      return { alreadyReplied: true };
    }
    const { positional, kv } = parseKwargs(args);
    if (positional.length < 2) {
      await reply(
        "Need at least &lt;name&gt; and &lt;trials&gt; positional args.",
      );
      return { alreadyReplied: true };
    }
    const trialsRaw = positional[positional.length - 1];
    const nTrialsTarget = parseInt(trialsRaw, 10);
    if (!Number.isFinite(nTrialsTarget) || nTrialsTarget < 10) {
      await reply(
        `⚠️ Trials must be an integer ≥ 10. Got <code>${esc(trialsRaw)}</code>.`,
      );
      return { alreadyReplied: true };
    }
    const name = positional.slice(0, -1).join(" ").trim();
    if (!name) {
      await reply("⚠️ Name cannot be empty.");
      return { alreadyReplied: true };
    }
    const algo = (kv.algo ?? "tpe") as
      | "random"
      | "tpe"
      | "nsga2"
      | "ensemble"
      | "ml-xgboost";
    if (!ALGORITHMS.has(algo)) {
      await reply(
        `⚠️ Unknown algo <code>${esc(algo)}</code>. Allowed: ${[...ALGORITHMS].join(", ")}.`,
      );
      return { alreadyReplied: true };
    }
    const seed = kv.seed ? parseInt(kv.seed, 10) : undefined;
    const cvType = (kv.cv ?? "cpcv") as "cpcv" | "walkforward";
    const cvStrategy: Record<string, unknown> = { type: cvType };
    if (kv.groups) cvStrategy.n_groups = parseInt(kv.groups, 10);
    if (kv.test) cvStrategy.n_test_groups = parseInt(kv.test, 10);
    if (kv.embargo) cvStrategy.embargo_pct = parseFloat(kv.embargo);

    const dataFilters: Record<string, unknown> = {};
    if (kv.books)
      dataFilters.includeSoftProviders = kv.books
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (kv.markets)
      dataFilters.includeMarketTypes = kv.markets
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (kv.from) dataFilters.eventStartFrom = `${kv.from}T00:00:00.000Z`;
    if (kv.to) dataFilters.eventStartTo = `${kv.to}T23:59:59.999Z`;
    if (kv.placed === "true" || kv.placed === "1")
      dataFilters.placedOnly = true;

    const summary: Array<[string, string]> = [
      ["Name", name],
      ["Trials", String(nTrialsTarget)],
      ["Algorithm", algo],
      ["CV", cvType],
    ];
    if (kv.from || kv.to)
      summary.push(["Window", `${kv.from ?? "—"} → ${kv.to ?? "—"}`]);
    if (kv.books) summary.push(["Books", kv.books]);
    if (kv.markets) summary.push(["Markets", kv.markets]);
    if (dataFilters.placedOnly) summary.push(["Placed only", "true"]);
    if (seed != null) summary.push(["Seed", String(seed)]);

    const description = [
      b("Confirm queue optimisation run"),
      "",
      kvList(summary),
    ].join("\n");

    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        try {
          const run = await createRun({
            name,
            searchAlgorithm: algo,
            nTrialsTarget,
            rngSeed: seed,
            cvStrategy: cvStrategy as never,
            dataFilters: dataFilters as never,
          });
          // Fire-and-forget kick — same pattern as the API route.
          void kickRunNow(run.id);
          return `🚀 Queued <b>${esc(run.name)}</b>\n<code>${esc(run.id)}</code>\nTrials ${run.nTrialsTarget} · ${esc(run.searchAlgorithm)}`;
        } catch (err) {
          return `⚠️ Failed to queue: ${esc((err as Error).message)}`;
        }
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /place <valueBetId> [stake] ──────────────────────────────────────────

registerCommand({
  name: "place",
  usage: "/place <valueBetId> [stake]",
  description: "Manually submit a bet to the book.",
  explanation:
    "Submits a bet to the soft book the value-bet was detected on. <code>valueBetId</code> is the in-memory id from /value (format <code>eventId:familyId:atomId</code>) — paste it as-is. " +
    "Stake is optional; default uses the recommended Kelly stake stored on the value bet. The placer enforces dedup (you can't place twice on the same selection), market limits, and balance checks. " +
    "<b>Real money is submitted on confirm.</b> Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length === 0) {
      await reply(
        "Usage: /place &lt;valueBetId&gt; [stake]. Copy the id from /value (eventId:familyId:atomId).",
      );
      return { alreadyReplied: true };
    }
    const idArg = args[0];
    const stakeArg = args[1] ? parseFloat(args[1]) : null;
    const all = storeGetValueBets();
    // Try exact match first, then prefix match, then "atomId" suffix match.
    const vb =
      all.find((v) => `${v.eventId}:${v.familyId}:${v.atomId}` === idArg) ??
      all.find((v) =>
        `${v.eventId}:${v.familyId}:${v.atomId}`.startsWith(idArg),
      );
    if (!vb) {
      await reply(
        `⚠️ No live value bet matches <code>${esc(idArg)}</code>. Re-run /value to get fresh ids — the in-memory store changes every odds sync.`,
      );
      return { alreadyReplied: true };
    }
    const stake = stakeArg && stakeArg > 0 ? stakeArg : vb.kellyStake;
    const description = [
      b("⚠️ Confirm bet placement"),
      "",
      kvList([
        ["Selection", `${vb.atomId} on ${vb.softProvider}`],
        ["Soft odds", vb.softOdds.toFixed(2)],
        ["Sharp odds", vb.sharpOdds.toFixed(2)],
        ["EV%", signedPct(vb.evPct)],
        ["Stake", money(stake)],
        ["Potential return", money(stake * vb.softOdds)],
      ]),
      "",
      "<i>Real money will be submitted to the book on confirm.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        // Build a runtime descriptor from the in-memory value bet — no need
        // to pre-persist; the placer's own persistence handles it.
        const runtimeRow = {
          id: `${vb.eventId}|${vb.familyId}|${vb.atomId}`,
          eventId: vb.eventId,
          familyId: vb.familyId,
          atomId: vb.atomId,
          atomLabel: vb.atomId,
          homeTeam: "—",
          awayTeam: "—",
          competition: null,
          eventStartTime: new Date().toISOString(),
          marketType: "MATCH_ODDS",
          timeScope: "FT",
          familyLine: null,
          sharpProvider: vb.sharpProvider,
          sharpOdds: vb.sharpOdds,
          sharpTrueProb: vb.trueProb,
          sharpOddsAgeMs: vb.sharpOddsAgeMs,
          softProvider: vb.softProvider,
          softCommissionPct: vb.commissionPct,
          softOdds: vb.softOdds,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          tickCount: 1,
          closingSharpOdds: null,
          closingSoftOdds: null,
          outcome: "pending",
          outcomeMarkedAt: null,
          settledBySource: null,
          settleAttempts: 0,
          lastSettleAttemptAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        try {
          const outcome = await placeBetForValueBet({
            valueBet: runtimeRow as never,
            kellyStake: stake,
            mode: "manual",
          });
          if (outcome.status === "placed") {
            return `✅ Placed <b>${esc(vb.atomId)}</b> @ ${(outcome as { bookedOdds?: number }).bookedOdds?.toFixed(2) ?? vb.softOdds.toFixed(2)} for ${money(stake)}\nTicket: <code>${esc((outcome as { ticketId?: string }).ticketId ?? "—")}</code>`;
          }
          if (outcome.status === "pending") {
            return `🟡 Pending confirmation — book accepted but ticket arrives async. Reconciler will attach it within ~30s.`;
          }
          return `❌ <b>${outcome.status}</b>${(outcome as { reason?: string }).reason ? ` — ${esc((outcome as { reason?: string }).reason ?? "")}` : ""}`;
        } catch (err) {
          return `⚠️ Placement error: ${esc((err as Error).message)}`;
        }
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /mark <betId> <outcome> ──────────────────────────────────────────────

const ALLOWED_OUTCOMES = new Set([
  "won",
  "lost",
  "void",
  "half_won",
  "half_lost",
  "pending",
]);

registerCommand({
  name: "mark",
  usage: "/mark <betId> <won|lost|void|half_won|half_lost|pending>",
  description: "Manually set a bet outcome and recompute P&L.",
  explanation:
    "Hard-overrides a bet's outcome — used to correct misclassified settlements (e.g. live feed said 'lost' but the actual scoreline was a void). " +
    "Triggers settlement P&L recompute and a Telegram settle-card if the bet was placed. " +
    "<b>Audit-trail-affecting</b>: the row's <code>settledBySource</code> is set to <code>telegram-manual</code>. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length < 2) {
      await reply(
        "Usage: /mark &lt;betId&gt; &lt;won|lost|void|half_won|half_lost|pending&gt;",
      );
      return { alreadyReplied: true };
    }
    const betId = args[0];
    const outcome = args[1].toLowerCase();
    if (!ALLOWED_OUTCOMES.has(outcome)) {
      await reply(
        `⚠️ Outcome must be one of: ${[...ALLOWED_OUTCOMES].join(", ")}`,
      );
      return { alreadyReplied: true };
    }
    const existing = await getBetById(betId);
    if (!existing) {
      await reply(`⚠️ No bet matches <code>${esc(betId)}</code>.`);
      return { alreadyReplied: true };
    }
    const description = [
      b("⚠️ Confirm outcome override"),
      "",
      kvList([
        ["Bet", `<code>${esc(existing.id)}</code>`],
        ["Current", String(existing.outcome ?? "—")],
        ["New", outcome],
        ["Stake", existing.stake != null ? money(Number(existing.stake)) : "—"],
        [
          "Odds",
          existing.odds != null ? Number(existing.odds).toFixed(2) : "—",
        ],
      ]),
      "",
      "<i>P&amp;L will be recomputed; a Telegram settle card will fire for placed bets.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        try {
          if (
            existing.placedAt &&
            outcome !== "pending" &&
            existing.outcome !== outcome
          ) {
            // Placed bet → use applySettlement so pnl gets recomputed.
            await applySettlement({
              betId: existing.id,
              outcome: outcome as
                | "won"
                | "lost"
                | "void"
                | "half_won"
                | "half_lost",
              settledBySource: "telegram-manual",
            });
          } else {
            await markOutcome(existing.id, outcome as never, "telegram-manual");
          }
          return `✅ Bet <code>${esc(existing.id)}</code> → <b>${esc(outcome)}</b>`;
        } catch (err) {
          return `⚠️ Update failed: ${esc((err as Error).message)}`;
        }
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /delete <betId> ──────────────────────────────────────────────────────

registerCommand({
  name: "delete",
  usage: "/delete <betId>",
  description: "Hard-delete a bet row from the database.",
  explanation:
    "Removes the bet row entirely. <b>Destructive — no undo.</b> Use only to clear a junk row (e.g. a duplicate that the reconciler couldn't resolve, or a test bet placed during dev). " +
    "Audit-trail-breaking: the row is gone for good. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length === 0) {
      await reply("Usage: /delete &lt;betId&gt;");
      return { alreadyReplied: true };
    }
    const betId = args[0];
    const existing = await getBetById(betId);
    if (!existing) {
      await reply(`⚠️ No bet matches <code>${esc(betId)}</code>.`);
      return { alreadyReplied: true };
    }
    const description = [
      b("⚠️ Confirm hard-delete"),
      "",
      kvList([
        ["Bet", `<code>${esc(existing.id)}</code>`],
        ["Selection", existing.atomLabel ?? "—"],
        ["Outcome", String(existing.outcome ?? "—")],
        ["Placed", existing.placedAt ? "yes" : "no"],
      ]),
      "",
      "<i>This row will be permanently removed.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        const ok = await deleteBet(betId);
        return ok
          ? `🗑 Deleted bet <code>${esc(betId)}</code>.`
          : `⚠️ Delete returned no rows — id may have already been removed.`;
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /promote <trialId> <name...> ─────────────────────────────────────────

const KNOWN_FILTER_KEYS = [
  "min_ev_pct",
  "max_odds_age_sec",
  "min_sharp_prob",
  "odds_lo",
  "odds_hi",
  "min_tick_count",
  "pre_match_only",
  "soft_providers",
  "market_types",
] as const;

registerCommand({
  name: "promote",
  usage: "/promote <trialId> <name…>",
  description: "Promote an optimisation trial to a live strategy.",
  explanation:
    "Creates a new strategy from a trial's parameters: filter keys (EV cutoff, odds range, allowed books, etc.) become the strategy's filters; sizing keys (Kelly fraction/cap, staking scheme) become its sizing. " +
    "Once promoted (and named in <code>betting_settings.active_strategy_ids</code>), the auto-placer will use it on future bets. " +
    "Trial id comes from /trials &lt;runId&gt;; everything after is the strategy name. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length < 2) {
      await reply("Usage: /promote &lt;trialId&gt; &lt;name…&gt;");
      return { alreadyReplied: true };
    }
    const trialId = args[0];
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      await reply("⚠️ Name cannot be empty.");
      return { alreadyReplied: true };
    }
    const [trial] = await db
      .select()
      .from(optimizationTrials)
      .where(eq(optimizationTrials.id, trialId))
      .limit(1);
    if (!trial) {
      await reply(`⚠️ No trial matches <code>${esc(trialId)}</code>.`);
      return { alreadyReplied: true };
    }
    const description = [
      b("⚠️ Confirm strategy promotion"),
      "",
      kvList([
        ["Trial", `<code>${esc(trial.id)}</code>`],
        ["Name", name],
        [
          "OOS ROI",
          trial.oosRoiMean != null ? signedPct(Number(trial.oosRoiMean)) : "—",
        ],
        [
          "Composite",
          trial.compositeScore != null
            ? Number(trial.compositeScore).toFixed(2)
            : "—",
        ],
      ]),
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        const params = (trial.params as Record<string, unknown>) ?? {};
        const filters: StrategyFilters = {};
        for (const k of KNOWN_FILTER_KEYS) {
          if (k in params) {
            (filters as Record<string, unknown>)[k] = params[k];
          }
        }
        const sizing: StrategySizing = {
          kelly_fraction:
            typeof params["kelly_fraction"] === "number"
              ? (params["kelly_fraction"] as number)
              : 0.25,
          kelly_cap_pct:
            typeof params["kelly_cap_pct"] === "number"
              ? (params["kelly_cap_pct"] as number)
              : 10,
          staking_scheme:
            typeof params["staking_scheme"] === "string"
              ? (params["staking_scheme"] as string)
              : "kelly",
        };
        const metricsSnapshot = {
          oosRoiMean: trial.oosRoiMean,
          oosRoiCiLow: trial.oosRoiCiLow,
          oosRoiCiHigh: trial.oosRoiCiHigh,
          oosSortino: trial.oosSortino,
          oosSharpe: trial.oosSharpe,
          deflatedSharpe: trial.deflatedSharpe,
          probabilisticSharpe: trial.probabilisticSharpe,
          maxDrawdown: trial.maxDrawdown,
          sampleSize: trial.sampleSize,
          compositeScore: trial.compositeScore,
          onPareto: trial.onPareto,
          promotedAt: new Date().toISOString(),
        };
        try {
          const row = await promoteStrategy({
            trialId: trial.id,
            runId: trial.runId,
            name,
            filters,
            sizing,
            metricsSnapshot,
            createdBy: "telegram",
          });
          return `🎛 Promoted <b>${esc(row.name)}</b>\n<code>${esc(row.id)}</code>\n<i>Add to active_strategy_ids in /set or the dashboard for the auto-placer to use it.</i>`;
        } catch (err) {
          return `⚠️ Promote failed: ${esc((err as Error).message)}`;
        }
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

// ── /autoplace-on <provider> ─────────────────────────────────────────────
// Lifted out of the read-only /autoplace command into its own
// confirm-gated destructive command — turning auto-place ON enables real
// money to flow without operator review, so it gets the same treatment as
// /place.

registerCommand({
  name: "autoplace-on",
  usage: "/autoplace-on <providerId>",
  description: "Enable auto-place for a provider (real-money flow).",
  explanation:
    "Turns the auto-placer ON for one provider. After this, every detected value bet that passes the auto-placer's filters will be submitted to the book without human review. " +
    "<b>Real money is at stake on every detection tick.</b> Make sure the daily caps and Kelly fraction in /settings are sane first. Confirm-gated.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    if (args.length === 0) {
      await reply("Usage: /autoplace-on &lt;providerId&gt;");
      return { alreadyReplied: true };
    }
    const providerId = args[0];
    const adapters = listBettingProviders();
    const adapter = adapters.find(
      (a) => a.providerId.toLowerCase() === providerId.toLowerCase(),
    );
    if (!adapter) {
      await reply(`⚠️ Unknown provider <code>${esc(providerId)}</code>.`);
      return { alreadyReplied: true };
    }
    const description = [
      b("⚠️ Confirm auto-place ON"),
      "",
      `Provider: <b>${esc(adapter.providerDisplayName)}</b>`,
      "",
      "<i>Every detected value bet that passes the auto-placer filters will be submitted to the book automatically. Real money flow.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () => {
        setAutoPlaceEnabled(adapter.providerId, true);
        return `🟢 Auto-place ON for <b>${esc(adapter.providerDisplayName)}</b>.`;
      },
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});
