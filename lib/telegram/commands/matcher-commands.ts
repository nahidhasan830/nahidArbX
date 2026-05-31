/**
 * Matcher Lab controls:
 *   /matcher_reviews, /matcher_review, /matcher_match, /matcher_reject,
 *   /matcher_keep, /matcher_run.
 */

import {
  countDecisionRows,
  listDecisionRows,
  markManualDecision,
  readDecisionRow,
  runEventMatcher,
} from "@/lib/event-matcher";
import { createConfirm } from "../confirm";
import { answerCallbackQuery, editMessageText, sendMessage } from "../client";
import { registerCommand } from "../registry";
import {
  ago,
  b,
  code,
  durationLabel,
  esc,
  header,
  kvList,
  num,
  truncate,
} from "../format";
import type { TgCallbackQuery, TgInlineKeyboard } from "../types";

type DecisionRow = Awaited<ReturnType<typeof listDecisionRows>>[number];
type ManualDecision = "auto_merge" | "auto_reject" | "human_review";

const REVIEW_LIMIT_MAX = 25;

function shortId(id: string): string {
  return id.slice(0, 8);
}

function eventLabel(event: DecisionRow["eventA"]): string {
  return `${event.homeTeam} vs ${event.awayTeam}`;
}

function formatKickoff(value: unknown): string {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!date || Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function scoreValue(row: DecisionRow, key: string): number | null {
  const score =
    row.scoreBreakdown && typeof row.scoreBreakdown === "object"
      ? (row.scoreBreakdown as Record<string, unknown>)
      : {};
  const value = score[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pctScore(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function reviewKeyboard(id: string): TgInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Match", callback_data: `m:a:${id}` },
        { text: "🚫 Reject", callback_data: `m:r:${id}` },
      ],
      [
        { text: "🔁 Re-run matcher", callback_data: `m:p:${id}` },
        { text: "⏸ Keep review", callback_data: `m:k:${id}` },
      ],
    ],
  };
}

async function renderReviewList(limit: number): Promise<{
  text: string;
  keyboard?: TgInlineKeyboard;
}> {
  const safeLimit = Math.min(REVIEW_LIMIT_MAX, Math.max(1, limit));
  const [rows, total] = await Promise.all([
    listDecisionRows({ decision: "human_review", limit: safeLimit }),
    countDecisionRows({ decision: "human_review" }),
  ]);
  if (rows.length === 0) {
    return { text: "✅ No Matcher Lab human-review items." };
  }

  const lines = [header("🧩", `Matcher human review · ${num(total)}`), ""];
  rows.forEach((row, index) => {
    const combined =
      typeof row.combinedScore === "number"
        ? row.combinedScore
        : scoreValue(row, "combined");
    lines.push(
      `${index + 1}. ${code(shortId(row.decisionId))} ${esc(row.providerA)} ↔ ${esc(row.providerB)} · ${pctScore(combined)}`,
      `A: ${esc(eventLabel(row.eventA))}`,
      `B: ${esc(eventLabel(row.eventB))}`,
      `⏱ ${formatKickoff(row.eventA.kickoff)} · ${ago(row.createdAt)}`,
      "",
    );
  });
  lines.push(
    "<i>Tap a row to review. Each row has match, reject, keep, and re-run controls.</i>",
  );

  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        ...rows.map((row, index) => [
          {
            text: `${index + 1}. ${shortId(row.decisionId)}`,
            callback_data: `m:v:${row.decisionId}`,
          },
        ]),
        [
          { text: "🔁 Re-run listed", callback_data: `m:P:${safeLimit}` },
          { text: "↻ Refresh", callback_data: `m:l:${safeLimit}` },
        ],
      ],
    },
  };
}

function formatReviewDetail(row: DecisionRow): string {
  const combined =
    typeof row.combinedScore === "number"
      ? row.combinedScore
      : scoreValue(row, "combined");
  const lines = [
    header("🧩", `Matcher review ${shortId(row.decisionId)}`),
    "",
    kvList([
      ["Decision id", code(row.decisionId)],
      ["Providers", `${esc(row.providerA)} ↔ ${esc(row.providerB)}`],
      ["Kickoff A", formatKickoff(row.eventA.kickoff)],
      ["Kickoff B", formatKickoff(row.eventB.kickoff)],
      ["Age", ago(row.createdAt)],
    ]),
    "",
    b("A"),
    `${esc(eventLabel(row.eventA))}`,
    row.eventA.competition ? esc(row.eventA.competition) : "—",
    "",
    b("B"),
    `${esc(eventLabel(row.eventB))}`,
    row.eventB.competition ? esc(row.eventB.competition) : "—",
    "",
    kvList([
      ["Combined", pctScore(combined)],
      ["Team", pctScore(scoreValue(row, "bestTeam"))],
      ["Competition", pctScore(scoreValue(row, "competition"))],
      ["Kickoff", pctScore(scoreValue(row, "kickoff"))],
      ["Reason", esc(truncate(row.reasonSummary, 220))],
    ]),
    "",
    `<i>Use buttons, or /matcher_match ${shortId(row.decisionId)}, /matcher_reject ${shortId(row.decisionId)}, /matcher_run ${shortId(row.decisionId)}.</i>`,
  ];
  return lines.join("\n");
}

function formatRunSummary(
  prefix: string,
  summary: Awaited<ReturnType<typeof runEventMatcher>>,
): string {
  const lines = [
    `${prefix} <b>Matcher run ${esc(summary.status)}</b>`,
    kvList([
      ["Run", code(summary.id)],
      ["Scored", num(summary.candidateCount)],
      ["Merged", num(summary.autoMerged)],
      ["Rejected", num(summary.autoRejected)],
      ["Human review", num(summary.humanReview)],
      ["DeepSeek reviewed", num(summary.deepseekReviewed)],
      ["Duration", durationLabel(summary.durationMs)],
    ]),
  ];
  if (summary.errorMessage) lines.push(`⚠️ ${esc(summary.errorMessage)}`);
  return lines.join("\n");
}

async function resolveDecisionArg(
  raw: string,
  opts?: { humanReviewOnly?: boolean },
): Promise<{ row: DecisionRow | null; error?: string }> {
  const value = raw.trim();
  if (!value) return { row: null, error: "Missing decision id." };

  const exact = await readDecisionRow(value);
  if (
    exact &&
    (!opts?.humanReviewOnly || exact.decision === "human_review")
  ) {
    return { row: exact };
  }

  if (value.length < 4) {
    return { row: null, error: "Use at least 4 id characters." };
  }

  const rows = await listDecisionRows({
    decision: opts?.humanReviewOnly ? "human_review" : undefined,
    limit: 100,
  });
  const matches = rows.filter((row) => row.decisionId.startsWith(value));
  if (matches.length === 1) return { row: matches[0] };
  if (matches.length > 1) {
    return {
      row: null,
      error: `Prefix ${code(value)} matches ${matches.length} rows. Use more characters.`,
    };
  }
  return { row: null, error: `No matcher decision matches ${code(value)}.` };
}

async function applyManualDecision(
  row: DecisionRow,
  decision: ManualDecision,
): Promise<string> {
  const ok = await markManualDecision({
    decisionId: row.decisionId,
    decision,
    reason:
      decision === "auto_merge"
        ? "Confirmed from Telegram."
        : decision === "auto_reject"
          ? "Rejected from Telegram."
          : "Kept in human review from Telegram.",
  });
  if (!ok) return `⚠️ Decision ${code(row.decisionId)} was not found.`;
  if (decision === "auto_merge") {
    return `✅ Matched ${code(row.decisionId)}\n${esc(eventLabel(row.eventA))}\n${esc(eventLabel(row.eventB))}`;
  }
  if (decision === "auto_reject") {
    return `🚫 Rejected ${code(row.decisionId)}\n${esc(eventLabel(row.eventA))}\n${esc(eventLabel(row.eventB))}`;
  }
  return `⏸ Kept in review ${code(row.decisionId)}`;
}

async function runMatcherForRows(rows: DecisionRow[]) {
  return runEventMatcher({
    trigger: "manual",
    mode: "apply",
    applyMerges: true,
    useDeepSeek: true,
    decisionIds: rows.map((row) => row.decisionId),
  });
}

registerCommand({
  name: "matcher_reviews",
  usage: "/matcher_reviews [n]",
  description: "List Matcher Lab human-review items.",
  explanation:
    "Shows the latest Matcher Lab rows that still need operator review. Tap a numbered button to open the pair, then match, reject, keep in review, or re-run the matcher from Telegram.",
  group: "read",
  async handler({ args, reply }) {
    const limit = Math.min(
      REVIEW_LIMIT_MAX,
      Math.max(1, parseInt(args[0] ?? "5", 10) || 5),
    );
    const rendered = await renderReviewList(limit);
    await reply(rendered.text, rendered.keyboard);
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "matcher_review",
  usage: "/matcher_review <decisionId|prefix>",
  description: "Open one Matcher Lab review item.",
  explanation:
    "Displays both provider fixtures, scores, reason, and action buttons for one Matcher Lab decision. You can paste the full id or the short id shown by /matcher_reviews.",
  group: "read",
  async handler({ args, reply }) {
    const resolved = await resolveDecisionArg(args[0] ?? "");
    if (!resolved.row) {
      await reply(`⚠️ ${resolved.error ?? "Decision not found."}`);
      return { alreadyReplied: true };
    }
    await reply(
      formatReviewDetail(resolved.row),
      reviewKeyboard(resolved.row.decisionId),
    );
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "matcher_match",
  usage: "/matcher_match <decisionId|prefix>",
  description: "Confirm a Matcher Lab pair as the same event.",
  explanation:
    "Manual match action for a review row. It writes the same canonical merge the Matcher Lab UI writes, with a confirm tap before applying.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    const resolved = await resolveDecisionArg(args[0] ?? "", {
      humanReviewOnly: true,
    });
    if (!resolved.row) {
      await reply(`⚠️ ${resolved.error ?? "Review item not found."}`);
      return { alreadyReplied: true };
    }
    const row = resolved.row;
    const description = [
      b("Confirm matcher merge"),
      "",
      kvList([
        ["Decision", code(row.decisionId)],
        ["A", esc(eventLabel(row.eventA))],
        ["B", esc(eventLabel(row.eventB))],
      ]),
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: () => applyManualDecision(row, "auto_merge"),
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "matcher_reject",
  usage: "/matcher_reject <decisionId|prefix>",
  description: "Reject a Matcher Lab pair as different events.",
  explanation:
    "Manual reject action for a review row. It marks the latest candidate decision as final reject, with a confirm tap before applying.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    const resolved = await resolveDecisionArg(args[0] ?? "", {
      humanReviewOnly: true,
    });
    if (!resolved.row) {
      await reply(`⚠️ ${resolved.error ?? "Review item not found."}`);
      return { alreadyReplied: true };
    }
    const row = resolved.row;
    const description = [
      b("Confirm matcher reject"),
      "",
      kvList([
        ["Decision", code(row.decisionId)],
        ["A", esc(eventLabel(row.eventA))],
        ["B", esc(eventLabel(row.eventB))],
      ]),
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: () => applyManualDecision(row, "auto_reject"),
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "matcher_keep",
  usage: "/matcher_keep <decisionId|prefix>",
  description: "Keep a Matcher Lab pair in human review.",
  explanation:
    "Leaves a row in the review queue after you inspect it. Mostly useful when you opened an item from Telegram but want to defer the decision.",
  group: "control",
  async handler({ args, reply }) {
    const resolved = await resolveDecisionArg(args[0] ?? "");
    if (!resolved.row) {
      await reply(`⚠️ ${resolved.error ?? "Decision not found."}`);
      return { alreadyReplied: true };
    }
    await reply(await applyManualDecision(resolved.row, "human_review"));
    return { alreadyReplied: true };
  },
});

registerCommand({
  name: "matcher_run",
  usage: "/matcher_run [decisionId|prefix|all]",
  description: "Run Matcher Lab pipeline for review items.",
  explanation:
    "Re-runs the matcher over one review item, or over the latest human-review queue with /matcher_run all. The run can auto-merge or auto-reject if the refreshed evidence is decisive.",
  group: "destructive",
  destructive: true,
  async handler({ args, reply, chatId, messageId }) {
    const target = (args[0] ?? "all").toLowerCase();
    let reviewRows: DecisionRow[];
    if (target !== "all") {
      const resolved = await resolveDecisionArg(args[0] ?? "", {
        humanReviewOnly: true,
      });
      if (!resolved.row) {
        await reply(`⚠️ ${resolved.error ?? "Review item not found."}`);
        return { alreadyReplied: true };
      }
      reviewRows = [resolved.row];
    } else {
      reviewRows = await listDecisionRows({
        decision: "human_review",
        limit: REVIEW_LIMIT_MAX,
      });
    }

    if (reviewRows.length === 0) {
      await reply("✅ No Matcher Lab human-review items to run.");
      return { alreadyReplied: true };
    }

    const description = [
      b("Confirm matcher run"),
      "",
      kvList([
        ["Rows", num(reviewRows.length)],
        [
          "Scope",
          target === "all"
            ? `latest ${num(reviewRows.length)} human-review rows`
            : code(reviewRows[0].decisionId),
        ],
      ]),
      "",
      "<i>This can apply canonical merges when the matcher becomes decisive.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId,
      messageId,
      run: async () =>
        formatRunSummary("🔁", await runMatcherForRows(reviewRows)),
    });
    await reply(description, keyboard);
    return { alreadyReplied: true };
  },
});

export async function handleMatcherCallback(
  query: TgCallbackQuery,
): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith("m:")) return false;

  const [, action, payload] = data.split(":");

  const editOrSend = async (text: string, kb?: TgInlineKeyboard) => {
    if (query.message) {
      await editMessageText({
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text,
        reply_markup: kb,
      });
    } else {
      await sendMessage({ chat_id: query.from.id, text, reply_markup: kb });
    }
  };

  if (action === "l") {
    await answerCallbackQuery({ callback_query_id: query.id });
    const limit = Math.min(
      REVIEW_LIMIT_MAX,
      Math.max(1, parseInt(payload ?? "5", 10) || 5),
    );
    const rendered = await renderReviewList(limit);
    await editOrSend(rendered.text, rendered.keyboard);
    return true;
  }

  if (action === "P") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Confirm matcher run.",
    });
    const limit = Math.min(
      REVIEW_LIMIT_MAX,
      Math.max(1, parseInt(payload ?? "5", 10) || 5),
    );
    const rows = await listDecisionRows({
      decision: "human_review",
      limit,
    });
    if (rows.length === 0) {
      await editOrSend("✅ No Matcher Lab human-review items to run.");
      return true;
    }
    const description = [
      b("Confirm matcher run"),
      "",
      kvList([
        ["Rows", num(rows.length)],
        ["Scope", `latest ${num(rows.length)} human-review rows`],
      ]),
      "",
      "<i>This can apply canonical merges when the matcher becomes decisive.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId: query.message?.chat.id ?? query.from.id,
      messageId: query.message?.message_id ?? 0,
      run: async () => formatRunSummary("🔁", await runMatcherForRows(rows)),
    });
    await editOrSend(description, keyboard);
    return true;
  }

  if (!payload) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Missing matcher decision id.",
      show_alert: true,
    });
    return true;
  }

  const row = await readDecisionRow(payload);
  if (!row) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Decision not found.",
      show_alert: true,
    });
    return true;
  }

  if (action === "v") {
    await answerCallbackQuery({ callback_query_id: query.id });
    await editOrSend(formatReviewDetail(row), reviewKeyboard(row.decisionId));
    return true;
  }

  if (action === "a" || action === "r") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Confirm this action.",
    });
    const decision: ManualDecision =
      action === "a" ? "auto_merge" : "auto_reject";
    const description = [
      b(action === "a" ? "Confirm matcher merge" : "Confirm matcher reject"),
      "",
      kvList([
        ["Decision", code(row.decisionId)],
        ["A", esc(eventLabel(row.eventA))],
        ["B", esc(eventLabel(row.eventB))],
      ]),
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId: query.message?.chat.id ?? query.from.id,
      messageId: query.message?.message_id ?? 0,
      run: () => applyManualDecision(row, decision),
    });
    await editOrSend(description, keyboard);
    return true;
  }

  if (action === "k") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Keeping in review…",
    });
    await editOrSend(await applyManualDecision(row, "human_review"));
    return true;
  }

  if (action === "p") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "Confirm matcher run.",
    });
    const description = [
      b("Confirm matcher run"),
      "",
      kvList([
        ["Rows", "1"],
        ["Scope", code(row.decisionId)],
      ]),
      "",
      "<i>This can apply canonical merges when the matcher becomes decisive.</i>",
    ].join("\n");
    const { keyboard } = createConfirm({
      description,
      chatId: query.message?.chat.id ?? query.from.id,
      messageId: query.message?.message_id ?? 0,
      run: async () => formatRunSummary("🔁", await runMatcherForRows([row])),
    });
    await editOrSend(description, keyboard);
    return true;
  }

  await answerCallbackQuery({
    callback_query_id: query.id,
    text: "Unknown matcher action.",
    show_alert: true,
  });
  return true;
}
