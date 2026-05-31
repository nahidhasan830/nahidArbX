import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SearchResult } from "./types";
import type { PlannedSearchQuery } from "./query-planner";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const NOW = new Date("2026-05-23T19:24:00.000Z");
const TIME_ZONE = "Asia/Dhaka";

async function getPlanner() {
  return import("./query-planner");
}

describe("search query planner", () => {
  it("builds five fixture angles for an ambiguous today query", async () => {
    const { planSearchQueries } = await getPlanner();
    const plan = await planSearchQueries("bologna vs inter milan today", {
      now: NOW,
      timeZone: TIME_ZONE,
      maxQueries: 5,
      planner: async () => ({ queries: [] }),
    });

    assert.equal(plan.timeZone, "Asia/Dhaka");
    assert.equal(plan.localDateLabel, "May 24, 2026");
    assert.equal(plan.previousLocalDateLabel, "May 23, 2026");
    assert.equal(plan.queries.length, 5);
    assert.equal(plan.queries[0].facet, "score_status");
    assert.match(plan.queries[0].query, /result today full time/i);
    assert(
      plan.queries.some((q) =>
        /final score May 23, 2026 May 24, 2026/i.test(q.query),
      ),
      "planner should include previous-date and local-date wording",
    );
    assert(plan.queries.some((q) => q.facet === "kickoff_time"));
    assert(plan.queries.some((q) => q.facet === "venue"));
  });

  it("keeps deterministic score, kickoff, and venue coverage when DeepSeek is narrow", async () => {
    const { planSearchQueries } = await getPlanner();
    const plan = await planSearchQueries("inter vs bologna today", {
      now: NOW,
      timeZone: TIME_ZONE,
      maxQueries: 5,
      planner: async () => ({
        queries: [
          {
            facet: "general",
            query: "inter vs bologna today",
            reason: "Original query.",
          },
        ],
      }),
    });

    assert.equal(plan.queries.length, 5);
    assert(plan.queries.some((q) => q.facet === "score_status"));
    assert(plan.queries.some((q) => q.facet === "kickoff_time"));
    assert(plan.queries.some((q) => q.facet === "venue"));
    assert(plan.queries.some((q) => q.query === "inter vs bologna today"));
  });

  it("recovers from malformed planner JSON with the deterministic fallback", async () => {
    const { planSearchQueries } = await getPlanner();
    const plan = await planSearchQueries("bologna vs inter milan today", {
      now: NOW,
      timeZone: TIME_ZONE,
      maxQueries: 5,
      planner: async () => "not-json",
    });

    assert.equal(plan.usedFallback, true);
    assert.equal(plan.queries.length, 5);
    assert.match(plan.queries[0].query, /result today full time/i);
  });

  it("does not call web search for greetings", async () => {
    const { runPlannedSearch } = await getPlanner();
    let searchCalls = 0;
    const run = await runPlannedSearch("Hi", {
      now: NOW,
      timeZone: TIME_ZONE,
      search: async () => {
        searchCalls++;
        return { provider: "vertex", results: [] };
      },
      planner: async () => ({
        search_needed: true,
        intent: "unknown",
        queries: [
          {
            facet: "general",
            query: "Hi",
            reason: "LLM was too broad.",
          },
        ],
      }),
    });

    assert.equal(searchCalls, 0);
    assert.equal(run.providerUsed, "none");
    assert.equal(run.plan.searchNeeded, false);
    assert.equal(run.plan.intent, "small_talk");
    assert.deepEqual(run.plan.queries, []);
  });

  it("honors DeepSeek no-search decisions for non-web chat", async () => {
    const { planSearchQueries } = await getPlanner();
    const plan = await planSearchQueries("explain what you can do", {
      now: NOW,
      timeZone: TIME_ZONE,
      planner: async () => ({
        search_needed: false,
        intent: "capability_question",
        no_search_reason: "This can be answered conversationally.",
        queries: [],
      }),
    });

    assert.equal(plan.searchNeeded, false);
    assert.equal(plan.intent, "capability_question");
    assert.equal(plan.noSearchReason, "This can be answered conversationally.");
    assert.deepEqual(plan.queries, []);
  });

  it("runs planned Vertex-primary searches and ranks final-score evidence first", async () => {
    const { runPlannedSearch } = await getPlanner();
    const calls: Array<{ query: string; providers?: string[] }> = [];
    const search = async (
      query: string,
      _maxResults: number,
      providers?: string[],
    ) => {
      calls.push({ query, providers });
      return {
        provider: "vertex",
        results: mockResultsForQuery(query),
      };
    };

    const run = await runPlannedSearch("bologna vs inter milan today", {
      now: NOW,
      timeZone: TIME_ZONE,
      maxQueries: 5,
      maxResults: 5,
      search,
      planner: async () => ({ queries: [] }),
    });

    assert.equal(run.providerUsed, "vertex");
    assert.equal(calls.length, 5);
    assert(calls.every((call) => call.providers?.join(",") === "vertex"));
    assert.equal(
      run.results[0].title,
      "Bologna vs Inter Milan: Italian Serie A stats & head-to-head - BBC",
    );
    assert.match(
      run.results[0].snippet,
      /Bologna 3 , Inter Milan 3 at Full time/,
    );
    assert(run.results[0].rankScore > run.results[1].rankScore);
  });

  it("demotes stale and wrong-opponent full-time pages", async () => {
    const { __queryPlannerTestHooks } = await getPlanner();
    const context = __queryPlannerTestHooks.buildTemporalContext(
      NOW,
      TIME_ZONE,
    );
    const plan = {
      originalQuery: "bologna vs inter milan today",
      timeZone: TIME_ZONE,
      localDate: context.localDate,
      localDateLabel: context.localDateLabel,
      previousLocalDateLabel: context.previousLocalDateLabel,
      utcNow: context.utcNow,
      searchNeeded: true,
      intent: "fixture_lookup",
      queries: [],
      usedFallback: true,
      model: "deepseek-v4-flash",
    };
    const planned: PlannedSearchQuery = {
      facet: "score_status",
      query: "bologna vs inter milan result today full time",
      reason: "score",
    };
    const correct = __queryPlannerTestHooks.scoreEvidence(
      result(
        "Bologna vs Inter Milan: Italian Serie A stats & head-to-head - BBC",
        "Bologna 3 , Inter Milan 3 at Full time. Sat 23 May 2026.",
        "https://www.bbc.com/sport/football/live/c99l74zvj3yt",
      ),
      planned,
      plan,
    );
    const wrongOpponent = __queryPlannerTestHooks.scoreEvidence(
      result(
        "Bologna vs AC Milan: Serie A stats & head-to-head - BBC Sport",
        "Bologna 0 , AC Milan 3 at Full time.",
        "https://www.bbc.com/sport/football/live/cpqy33xxzz5t",
      ),
      planned,
      plan,
    );
    const stale = __queryPlannerTestHooks.scoreEvidence(
      result(
        "Bologna 1-0 Inter Milan (Apr 20, 2025) Final Score - ESPN",
        "Game summary of Bologna vs Internazionale, final score 1-0, from April 20, 2025.",
        "https://www.espn.com/soccer/match/_/gameId/712434/internazionale-bologna",
      ),
      planned,
      plan,
    );

    assert(correct > wrongOpponent);
    assert(correct > stale);
  });
});

function mockResultsForQuery(query: string): SearchResult[] {
  if (/result today full time/i.test(query)) {
    return [
      result(
        "Bologna vs Inter live score, H2H and lineups - Sofascore",
        "Bologna is going head to head with Inter starting on 23 May 2026 at 16:00 UTC.",
        "https://www.sofascore.com/football/match/inter-bologna/KdbsXdb",
      ),
      result(
        "Bologna vs Inter Milan: Italian Serie A stats & head-to-head - BBC",
        "2 hours ago ... Bologna v Inter Milan. Match Summary. Sat 23 May 2026. Italian Serie A. Bologna 3 , Inter Milan 3 at Full time.",
        "https://www.bbc.com/sport/football/live/c99l74zvj3yt",
      ),
    ];
  }

  if (/final score/i.test(query)) {
    return [
      result(
        "Bologna 1-0 Inter Milan (Apr 20, 2025) Final Score - ESPN",
        "Game summary of Bologna vs Internazionale, final score 1-0, from April 20, 2025.",
        "https://www.espn.com/soccer/match/_/gameId/712434/internazionale-bologna",
      ),
    ];
  }

  if (/venue|stadium/i.test(query)) {
    return [
      result(
        "Bologna vs Inter live score, H2H and lineups - Sofascore",
        "Bologna is going head to head with Inter at Renato Dall'Ara stadium, Bologna city, Italy.",
        "https://www.sofascore.com/football/match/inter-bologna/KdbsXdb",
      ),
    ];
  }

  return [
    result(
      "Bologna vs. Inter Milan (May 23, 2026) Live Score - ESPN",
      "Live coverage of the Bologna vs. Internazionale Italian Serie A game on ESPN.",
      "https://www.espn.com/soccer/match/_/gameId/737154",
    ),
  ];
}

function result(title: string, snippet: string, url: string): SearchResult {
  return {
    title,
    snippet,
    content: snippet,
    url,
    source: "vertex",
  };
}
