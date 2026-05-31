import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMatcher = {
  countDecisionRows: vi.fn(),
  listDecisionRows: vi.fn(),
  markManualDecision: vi.fn(),
  readDecisionRow: vi.fn(),
  runEventMatcher: vi.fn(),
};

vi.mock("@/lib/event-matcher", () => eventMatcher);
vi.mock("@/lib/shared/logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const { notify } = await import("../../../lib/notifier");
const { handleMatcherCallback } = await import(
  "../../../lib/telegram/commands/matcher-commands"
);

const row = {
  decisionId: "b3d3f9ff-ca77-4343-9cf4-8263e8f56e44",
  decision: "human_review",
  providerA: "ninewickets-sportsbook",
  providerB: "velki-sportsbook",
  combinedScore: 0.721,
  scoreBreakdown: {
    bestTeam: 0.61,
    competition: 0.44,
    kickoff: 1,
  },
  reasonSummary: "Ambiguous provider pair needs operator review.",
  createdAt: "2026-05-31T04:00:00.000Z",
  eventA: {
    homeTeam: "Egersund",
    awayTeam: "Stromsgodset",
    competition: "Norway",
    kickoff: "2026-05-31T12:00:00.000Z",
  },
  eventB: {
    homeTeam: "Strommen",
    awayTeam: "Sogndal",
    competition: "Norway",
    kickoff: "2026-05-31T12:00:00.000Z",
  },
};

function fetchBodies() {
  return vi
    .mocked(global.fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")));
}

describe("Telegram matcher review flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "12345";
    global.fetch = vi.fn(async () => {
      return Response.json({ ok: true, result: { message_id: 99 } });
    }) as typeof fetch;

    eventMatcher.countDecisionRows.mockResolvedValue(3);
    eventMatcher.listDecisionRows.mockResolvedValue([row]);
    eventMatcher.readDecisionRow.mockResolvedValue(row);
    eventMatcher.markManualDecision.mockResolvedValue(true);
    eventMatcher.runEventMatcher.mockResolvedValue({
      id: "run-1",
      mode: "apply",
      status: "completed",
      snapshotCount: 2,
      candidateCount: 1,
      generatedCandidateCount: 1,
      skippedCandidateCount: 0,
      autoMerged: 1,
      autoRejected: 0,
      deepseekReviewed: 1,
      humanReview: 0,
      durationMs: 1200,
    });
  });

  it("sends an actionable matcher review alert and drops zero-review runs", async () => {
    await notify({
      type: "ml:run_completed",
      at: "2026-05-31T04:00:00.000Z",
      processed: 16,
      generated: 644,
      skipped: 628,
      merged: 16,
      rejected: 0,
      escalated: 0,
      durationMs: 128_600,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    await notify({
      type: "ml:run_completed",
      at: "2026-05-31T04:00:00.000Z",
      processed: 16,
      generated: 644,
      skipped: 628,
      merged: 12,
      rejected: 1,
      escalated: 3,
      durationMs: 128_600,
    });

    const sendBody = fetchBodies()[0];
    expect(sendBody.text).toContain("Matcher Review Needed");
    expect(sendBody.text).toContain("Human review: <b>3</b>");
    expect(sendBody.reply_markup.inline_keyboard).toEqual([
      [{ text: "Review 3 now", callback_data: "m:l:3" }],
    ]);
  });

  it("opens the review queue from the alert button, then opens a row", async () => {
    await handleMatcherCallback({
      id: "callback-queue",
      from: { id: 12345, is_bot: false },
      message: {
        message_id: 10,
        chat: { id: 12345, type: "private" },
        date: 0,
      },
      data: "m:l:3",
    });

    expect(eventMatcher.listDecisionRows).toHaveBeenCalledWith({
      decision: "human_review",
      limit: 3,
    });
    const queueEdit = fetchBodies().find((body) =>
      String(body.text).includes("Matcher human review"),
    );
    expect(queueEdit?.reply_markup.inline_keyboard).toContainEqual([
      { text: "1. b3d3f9ff", callback_data: `m:v:${row.decisionId}` },
    ]);
    expect(queueEdit?.reply_markup.inline_keyboard).toContainEqual([
      { text: "🔁 Re-run listed", callback_data: "m:P:3" },
      { text: "↻ Refresh", callback_data: "m:l:3" },
    ]);

    vi.clearAllMocks();
    global.fetch = vi.fn(async () => {
      return Response.json({ ok: true, result: { message_id: 100 } });
    }) as typeof fetch;
    await handleMatcherCallback({
      id: "callback-row",
      from: { id: 12345, is_bot: false },
      message: {
        message_id: 10,
        chat: { id: 12345, type: "private" },
        date: 0,
      },
      data: `m:v:${row.decisionId}`,
    });

    const detailEdit = fetchBodies().find((body) =>
      String(body.text).includes("Matcher review b3d3f9ff"),
    );
    expect(detailEdit?.text).toContain("Egersund vs Stromsgodset");
    expect(detailEdit?.text).toContain("Strommen vs Sogndal");
    expect(detailEdit?.reply_markup.inline_keyboard[0]).toEqual([
      { text: "✅ Match", callback_data: `m:a:${row.decisionId}` },
      { text: "🚫 Reject", callback_data: `m:r:${row.decisionId}` },
    ]);
  });

  it("turns the match button into a confirm-gated action", async () => {
    await handleMatcherCallback({
      id: "callback-match",
      from: { id: 12345, is_bot: false },
      message: {
        message_id: 10,
        chat: { id: 12345, type: "private" },
        date: 0,
      },
      data: `m:a:${row.decisionId}`,
    });

    expect(eventMatcher.markManualDecision).not.toHaveBeenCalled();
    const confirmEdit = fetchBodies().find((body) =>
      String(body.text).includes("Confirm matcher merge"),
    );
    expect(confirmEdit?.reply_markup.inline_keyboard[0][0].callback_data).toMatch(
      /^c:/,
    );
    expect(confirmEdit?.reply_markup.inline_keyboard[0][1].callback_data).toMatch(
      /^x:/,
    );
  });
});
