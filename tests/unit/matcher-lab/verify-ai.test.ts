/**
 * Tests for the AI event-matching verify-ai route handler.
 * Mocks DB + AI dependencies to validate routing, validation, and error handling.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap mock refs in vi.hoisted so vitest's vi.mock hoisting can access them.
const { mockGetById, mockMatchSingle, mockLogger } = vi.hoisted(() => ({
  mockGetById: vi.fn(),
  mockMatchSingle: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/db/repositories/match-pairs", () => ({
  getById: mockGetById,
}));

vi.mock("@/lib/matching/ai-search-client", () => ({
  matchSingle: mockMatchSingle,
}));

vi.mock("@/lib/shared/logger", () => ({
  logger: mockLogger,
}));

// ── Test subject (imported AFTER mocks) ──
import { POST } from "@/app/api/matcher-lab/verify-ai/route";

// ── Helpers ────────────
function jsonBody(obj: unknown): Request {
  return new Request("http://localhost/api/matcher-lab/verify-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
}

function makePair(overrides: Record<string, unknown> = {}) {
  return {
    id: "pair-001",
    eventAHomeTeam: "Arsenal",
    eventAAwayTeam: "Chelsea",
    eventACompetition: "Premier League",
    eventAStartTime: "2026-05-16T15:00:00Z",
    eventAProvider: "pinnacle",
    eventBHomeTeam: "Arsenal",
    eventBAwayTeam: "Chelsea",
    eventBCompetition: "Premier League",
    eventBStartTime: "2026-05-16T15:00:00Z",
    eventBProvider: "ninewickets-sportsbook",
    ...overrides,
  };
}

function makeVerdict(overrides = {}) {
  return {
    decision: "SAME",
    confidence: 0.95,
    model: "deepseek-v4-flash",
    reasoning: "Both events have identical teams and kickoff times.",
    sources: [{ url: "https://example.com", title: "Fixture", snippet: "..." }],
    searchQueriesUsed: ["Arsenal Chelsea Premier League"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Input Validation ─────────────────────────────────────────────────

describe("verify-ai: input validation", () => {
  it("rejects missing id", async () => {
    const res = await POST(jsonBody({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing or invalid id");
  });

  it("rejects null id", async () => {
    const res = await POST(jsonBody({ id: null }));
    expect(res.status).toBe(400);
  });

  it("rejects numeric id", async () => {
    const res = await POST(jsonBody({ id: 123 }));
    expect(res.status).toBe(400);
  });

  it("rejects empty string id", async () => {
    const res = await POST(jsonBody({ id: "" }));
    expect(res.status).toBe(400);
  });
});

// ── Pair Not Found ───────────────────────────────────────────────────

describe("verify-ai: pair lookup", () => {
  it("returns 404 when pair not found", async () => {
    mockGetById.mockResolvedValueOnce(null);
    const res = await POST(jsonBody({ id: "nonexistent" }));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Pair not found");
  });
});

// ── AI Search (DeepSeek) Routing ─────────────────────────────────────

describe("verify-ai: ai-search routing", () => {
  it("routes to ai-search when engine=ai-search", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockResolvedValueOnce(makeVerdict());

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.result.decision).toBe("SAME");
    expect(data.result.confidence).toBe(0.95);
    expect(data.result.engine).toBe("ai-search");
    expect(data.result.model).toBe("deepseek-v4-flash");
    expect(data.result.sources).toBeDefined();
    expect(data.result.searchQueriesUsed).toBeDefined();

    // Called with the correct event data
    expect(mockMatchSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        home_team: "Arsenal",
        away_team: "Chelsea",
        competition: "Premier League",
        provider: "pinnacle",
      }),
      expect.objectContaining({
        home_team: "Arsenal",
        away_team: "Chelsea",
        competition: "Premier League",
        provider: "ninewickets-sportsbook",
      }),
    );
  });

  it("ai-search returns SAME decision", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockResolvedValueOnce(
      makeVerdict({ decision: "SAME", confidence: 0.98 }),
    );

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.decision).toBe("SAME");
    expect(data.result.confidence).toBe(0.98);
  });

  it("ai-search returns NOT_SAME decision", async () => {
    mockGetById.mockResolvedValueOnce(
      makePair({
        eventBHomeTeam: "Manchester United",
        eventBAwayTeam: "Liverpool",
        eventBCompetition: "FA Cup",
      }),
    );
    mockMatchSingle.mockResolvedValueOnce(
      makeVerdict({ decision: "NOT_SAME", confidence: 0.99 }),
    );

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.decision).toBe("NOT_SAME");
  });

  it("ai-search returns UNCERTAIN decision", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockResolvedValueOnce(
      makeVerdict({ decision: "UNCERTAIN", confidence: 0.55 }),
    );

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.result.decision).toBe("UNCERTAIN");
    expect(data.result.confidence).toBe(0.55);
  });

  it("ai-search returns 503 when matchSingle returns null", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockResolvedValueOnce(null);

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("AI Search service unreachable");
  });
});

// ── DeepSeek-only routing ────────────────────────────────────────────

describe("verify-ai: DeepSeek-only routing", () => {
  it("routes to ai-search by default (no engine specified)", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockResolvedValueOnce(makeVerdict());

    const res = await POST(jsonBody({ id: "pair-001" }));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.result.decision).toBe("SAME");
    expect(data.result.engine).toBe("ai-search");

    expect(mockMatchSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        home_team: "Arsenal",
        away_team: "Chelsea",
        competition: "Premier League",
      }),
      expect.objectContaining({
        home_team: "Arsenal",
        away_team: "Chelsea",
        competition: "Premier League",
      }),
    );
  });

  it("rejects gemini explicitly", async () => {
    mockGetById.mockResolvedValueOnce(makePair());

    const res = await POST(
      jsonBody({ id: "pair-001", engine: "gemini", model: "pro" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Event matching uses DeepSeek Flash only");
    expect(mockMatchSingle).not.toHaveBeenCalled();
  });
});

// ── Error Handling ───────────────────────────────────────────────────

describe("verify-ai: error handling", () => {
  it("returns 500 on unexpected errors", async () => {
    mockGetById.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await POST(jsonBody({ id: "pair-001" }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("DB connection lost");
  });

  it("handles ai-search errors gracefully", async () => {
    mockGetById.mockResolvedValueOnce(makePair());
    mockMatchSingle.mockRejectedValueOnce(new Error("DeepSeek API rate limit"));

    const res = await POST(jsonBody({ id: "pair-001", engine: "ai-search" }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("DeepSeek API rate limit");
  });
});
