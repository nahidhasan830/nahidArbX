
import {
  applySettlement,
  deleteBet,
  getBetById,
  markOutcome,
} from "@/lib/db/repositories/bets";
import { placeBetForValueBet } from "@/lib/betting/placer";
import { getValueBets as storeGetValueBets } from "@/lib/store";
import { setAutoPlaceEnabled } from "@/lib/betting/auto-place-config";
import { listBettingProviders } from "@/lib/betting/registry";
import { createConfirm } from "../confirm";
import { registerCommand } from "../registry";
import { b, esc, kvList, money, signedPct } from "../format";

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
          softProvider: vb.softProvider,
          softCommissionPct: vb.commissionPct,
          softOdds: vb.softOdds,
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          tickCount: 1,
          closingSharpOdds: null,
          outcome: "pending",
          settledBySource: null,
          settledAt: null,
          settleAttempts: 0,
          lastSettleAttemptAt: null,
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


registerCommand({
  name: "autoplaceon",
  usage: "/autoplaceon <providerId>",
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
