import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const eventMatcher = {
  countDecisionRows: vi.fn(),
  countDecisions: vi.fn(),
  decisionCountsForDecisionRows: vi.fn(),
  decisionCountsByDecision: vi.fn(),
  getEventMatcherConfig: vi.fn(),
  listDecisionRows: vi.fn(),
  markManualDecision: vi.fn(),
  readCanonicalClusters: vi.fn(),
  readDecisionRow: vi.fn(),
  readEventMatcherRunJob: vi.fn(),
  readImpact: vi.fn(),
  readLatestEventMatcherRunJob: vi.fn(),
  readReliabilityStats: vi.fn(),
  runEventMatcher: vi.fn(),
  startEventMatcherRunJob: vi.fn(),
};

const schedulerRepository = {
  getEventMatcherSchedulerSettings: vi.fn(),
  updateEventMatcherSchedulerSettings: vi.fn(),
};

vi.mock("@/lib/event-matcher", () => eventMatcher);
vi.mock("@/lib/db/repositories/event-matcher-scheduler-settings", () => ({
  getEventMatcherSchedulerSettings:
    schedulerRepository.getEventMatcherSchedulerSettings,
  updateEventMatcherSchedulerSettings:
    schedulerRepository.updateEventMatcherSchedulerSettings,
}));

const matcherRoute = await import("../../../app/api/matcher-lab/route");
const streamRoute = await import(
  "../../../app/api/matcher-lab/run-stream/route"
);
const jobsRoute = await import("../../../app/api/matcher-lab/jobs/route");
const jobRoute = await import(
  "../../../app/api/matcher-lab/jobs/[jobId]/route"
);
const statsRoute = await import("../../../app/api/matcher-lab/stats/route");
const schedulerRoute = await import(
  "../../../app/api/matcher-lab/scheduler/route"
);

function request(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
  });
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("Matcher Lab API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventMatcher.getEventMatcherConfig.mockReturnValue({
      scoringVersion: "test-scoring",
      groundingVersion: "test-grounding",
    });
  });

  it("lists matcher decisions with decision tabs, run scope, and pagination", async () => {
    eventMatcher.listDecisionRows.mockResolvedValueOnce([{ decisionId: "d1" }]);
    eventMatcher.countDecisionRows.mockResolvedValueOnce(1);
    eventMatcher.decisionCountsForDecisionRows.mockResolvedValueOnce([
      { decision: "human_review", count: 1 },
    ]);

    const response = await matcherRoute.GET(
      request(
        "http://localhost/api/matcher-lab?runId=run-1&decision=human_review&limit=999&offset=3",
      ),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.rows).toEqual([{ decisionId: "d1" }]);
    expect(eventMatcher.listDecisionRows).toHaveBeenCalledWith({
      runId: "run-1",
      decision: "human_review",
      limit: 500,
      offset: 3,
    });
    expect(body.total).toBe(1);
    expect(body.decisionCounts).toEqual([{ decision: "human_review", count: 1 }]);
    expect(eventMatcher.countDecisionRows).toHaveBeenCalledWith({
      runId: "run-1",
      decision: "human_review",
    });
    expect(eventMatcher.decisionCountsForDecisionRows).toHaveBeenCalledWith({
      runId: "run-1",
    });
  });

  it("rejects invalid matcher decision tab filters", async () => {
    const response = await matcherRoute.GET(
      request("http://localhost/api/matcher-lab?decision=maybe"),
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "Invalid decision: maybe" });
    expect(eventMatcher.listDecisionRows).not.toHaveBeenCalled();
  });

  it("runs the matcher from the API and forwards scoped decision ids", async () => {
    eventMatcher.runEventMatcher.mockResolvedValueOnce({
      id: "run-1",
      status: "completed",
      candidateCount: 4,
    });

    const response = await matcherRoute.POST(
      request("http://localhost/api/matcher-lab", {
        action: "run",
        decisionIds: ["d1", "", 7, "d2"],
        useDeepSeek: false,
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ id: "run-1" });
    expect(eventMatcher.runEventMatcher).toHaveBeenCalledWith({
      trigger: "manual",
      mode: "apply",
      applyMerges: true,
      decisionIds: ["d1", "d2"],
      useDeepSeek: false,
    });
  });

  it("applies batch manual decisions and preserves per-row success", async () => {
    eventMatcher.markManualDecision
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const response = await matcherRoute.POST(
      request("http://localhost/api/matcher-lab", {
        action: "manual-decisions",
        items: [
          {
            decisionId: "d1",
            decision: "auto_merge",
            reason: "source checked",
          },
          {
            decisionId: "d2",
            decision: "human_review",
            reason: "needs more evidence",
          },
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      success: true,
      results: [
        { decisionId: "d1", success: true },
        { decisionId: "d2", success: false },
      ],
    });
    expect(eventMatcher.markManualDecision).toHaveBeenCalledTimes(2);
  });

  it("streams matcher run progress as newline-delimited JSON", async () => {
    eventMatcher.runEventMatcher.mockImplementationOnce(async (opts) => {
      await opts.onProgress({
        runId: "run-stream",
        mode: "apply",
        phase: "completed",
        message: "done",
        timestamp: "2026-06-01T00:00:00.000Z",
        elapsedMs: 1,
        counters: {
          snapshots: 2,
          generatedCandidates: 1,
          candidatesToScore: 1,
          skippedCandidates: 0,
          scoredCandidates: 1,
          insertedCandidates: 1,
          autoMerged: 1,
          autoRejected: 0,
          deepseekReviewed: 0,
          humanReview: 0,
        },
        summary: { id: "run-stream", status: "completed" },
      });
      return { id: "run-stream", status: "completed", candidateCount: 1 };
    });

    const response = await streamRoute.POST(
      request("http://localhost/api/matcher-lab/run-stream", {
        decisionIds: ["d1", 9, "d2"],
        useDeepSeek: true,
      }),
    );
    const lines = (await response.text()).trim().split("\n");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("ndjson");
    expect(JSON.parse(lines[0])).toMatchObject({
      phase: "completed",
      summary: { id: "run-stream" },
    });
    expect(eventMatcher.runEventMatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "manual",
        mode: "apply",
        applyMerges: true,
        decisionIds: ["d1", "d2"],
        useDeepSeek: true,
      }),
    );
  });

  it("queues server-side matcher jobs and sanitizes selected ids", async () => {
    eventMatcher.startEventMatcherRunJob.mockResolvedValueOnce({
      id: "job-1",
      status: "queued",
      events: [],
    });

    const response = await jobsRoute.POST(
      request("http://localhost/api/matcher-lab/jobs", {
        decisionIds: ["d1", "", 8, "d2"],
        useDeepSeek: false,
      }),
    );

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({
      job: { id: "job-1", status: "queued", events: [] },
    });
    expect(eventMatcher.startEventMatcherRunJob).toHaveBeenCalledWith({
      decisionIds: ["d1", "d2"],
      useDeepSeek: false,
    });
  });

  it("reads active and exact matcher jobs for refresh recovery", async () => {
    eventMatcher.readLatestEventMatcherRunJob.mockResolvedValueOnce({
      id: "job-active",
      status: "running",
      events: [],
    });
    eventMatcher.readEventMatcherRunJob.mockResolvedValueOnce({
      id: "job-active",
      status: "running",
      events: [],
    });

    const latestResponse = await jobsRoute.GET(
      request("http://localhost/api/matcher-lab/jobs?active=1"),
    );
    const exactResponse = await jobRoute.GET(
      request("http://localhost/api/matcher-lab/jobs/job-active"),
      { params: Promise.resolve({ jobId: "job-active" }) },
    );

    expect(latestResponse.status).toBe(200);
    expect(await json(latestResponse)).toMatchObject({
      job: { id: "job-active" },
    });
    expect(exactResponse.status).toBe(200);
    expect(await json(exactResponse)).toMatchObject({
      job: { id: "job-active" },
    });
    expect(eventMatcher.readLatestEventMatcherRunJob).toHaveBeenCalledWith({
      activeOnly: true,
    });
    expect(eventMatcher.readEventMatcherRunJob).toHaveBeenCalledWith(
      "job-active",
    );
  });

  it("returns matcher stats from all backing readers", async () => {
    eventMatcher.readImpact.mockResolvedValueOnce([{ day: "2026-06-01" }]);
    eventMatcher.decisionCountsByDecision.mockResolvedValueOnce([
      { decision: "auto_merge", count: 2 },
    ]);
    eventMatcher.countDecisions.mockResolvedValueOnce(3);
    eventMatcher.readReliabilityStats.mockResolvedValueOnce({ healthy: true });
    eventMatcher.readCanonicalClusters.mockResolvedValueOnce([
      { canonicalEventId: "canonical-1" },
    ]);

    const response = await statsRoute.GET(
      request("http://localhost/api/matcher-lab/stats"),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      impact: [{ day: "2026-06-01" }],
      decisionCounts: [{ decision: "auto_merge", count: 2 }],
      reviewCount: 3,
      reliability: { healthy: true },
      clusters: [{ canonicalEventId: "canonical-1" }],
    });
    expect(eventMatcher.readImpact).toHaveBeenCalledWith(50);
    expect(eventMatcher.countDecisions).toHaveBeenCalledWith({
      decision: "human_review",
    });
  });

  it("reads and updates matcher scheduler settings with interval clamping", async () => {
    schedulerRepository.getEventMatcherSchedulerSettings.mockResolvedValueOnce({
      row: { id: "default", enabled: true },
      ready: true,
    });
    schedulerRepository.updateEventMatcherSchedulerSettings.mockResolvedValueOnce(
      {
        id: "default",
        enabled: false,
        useDeepSeek: true,
        intervalSeconds: 15,
      },
    );

    const getResponse = await schedulerRoute.GET();
    const putResponse = await schedulerRoute.PUT(
      new NextRequest("http://localhost/api/matcher-lab/scheduler", {
        method: "PUT",
        body: JSON.stringify({
          enabled: false,
          useDeepSeek: true,
          intervalSeconds: 4,
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(getResponse.status).toBe(200);
    expect(await json(getResponse)).toEqual({
      row: { id: "default", enabled: true },
      ready: true,
    });
    expect(putResponse.status).toBe(200);
    expect(await json(putResponse)).toMatchObject({
      row: { intervalSeconds: 15 },
      ready: true,
    });
    expect(
      schedulerRepository.updateEventMatcherSchedulerSettings,
    ).toHaveBeenCalledWith({
      enabled: false,
      useDeepSeek: true,
      intervalSeconds: 15,
    });
  });
});
