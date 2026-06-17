import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

async function getHooks() {
  const mod = await import("./grounding");
  return mod.__groundingTestHooks;
}

describe("grounding entity-match parsing", () => {
  it("labels automated grounding kickoff prompts in UTC only", async () => {
    const { entityMatchPrompt } = await import("./prompts");
    const prompt = entityMatchPrompt(
      {
        homeTeam: "Tartu JK Tammeka",
        awayTeam: "Levadia Tallinn",
        competition: "Estonia - Meistriliiga",
        startTime: "2026-05-30T14:00:00.000Z",
        provider: "pinnacle",
      },
      {
        homeTeam: "Tammeka Tartu",
        awayTeam: "FCI Tallinn",
        competition: "Estonian Premier League",
        startTime: "2026-05-30T14:00:00.000Z",
        provider: "velki-sportsbook",
      },
    );

    assert.match(prompt, /30 May 2026 14:00:00 UTC/);
    assert.doesNotMatch(prompt, /Asia\/Dhaka|BDT|20:00:00/);
    assert.match(prompt, /use the UTC kickoff timestamp/);
  });

  it("recovers a decisive verdict from truncated DeepSeek JSON", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      `{
  "decision": "DIFFERENT",
  "confidence": 95,
  "reasoning": "The first fixture involves Dukla Prague and Banik Ostrava in the Czech 1 Liga, while the second involves Banik Ostrava B and Sparta Prague B in the Czech 2 Liga; web evidence confirms separate matches`,
      { finishReason: "length" },
    );

    assert.equal(verdict.decision, "DIFFERENT");
    assert.equal(verdict.confidence, 95);
    assert.match(verdict.reasoning, /\[truncated\]/);
    assert.deepEqual(verdict.diagnostics, {
      parseStatus: "recovered",
      finishReason: "length",
      warning: "Recovered fields from a truncated AI JSON response.",
    });
  });

  it("surfaces unrecoverable truncation as an explicit uncertain parse failure", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict("", {
      finishReason: "length",
      eventA: {
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        competition: "Premier League",
        startTime: "2026-05-23T12:00:00Z",
      },
      eventB: {
        homeTeam: "Arsenal",
        awayTeam: "Chelsea",
        competition: "Premier League",
        startTime: "2026-05-23T12:00:00Z",
      },
    });

    assert.equal(verdict.decision, "UNCERTAIN");
    assert.equal(verdict.confidence, 50);
    assert.match(verdict.reasoning, /truncated/);
    assert.deepEqual(verdict.diagnostics, {
      parseStatus: "invalid",
      finishReason: "length",
      warning: "AI response was truncated before valid JSON could be parsed.",
    });
  });

  it("parses wrapped batch verdicts and normalizes prompt pair numbers to zero-based indexes", async () => {
    const hooks = await getHooks();
    const result = hooks.parseBatchVerdict(
      JSON.stringify({
        verdicts: [
          {
            pair: 1,
            decision: "SAME",
            confidence: 91,
            reasoning: "same fixture",
          },
          {
            pair: 2,
            decision: "DIFFERENT",
            confidence: 94,
            reasoning: "different teams",
          },
        ],
      }),
      2,
    );

    assert.equal(result.verdicts[0].pairIndex, 0);
    assert.equal(result.verdicts[0].decision, "SAME");
    assert.equal(result.verdicts[1].pairIndex, 1);
    assert.equal(result.verdicts[1].decision, "DIFFERENT");
  });

  it("preserves structured canonical facts from entity-match JSON", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "SAME",
        confidence: 93,
        reasoning: "official fixture evidence aligns",
        canonicalEvent: {
          home: "Manchester United",
          away: "Chelsea",
          competition: "Premier League",
          kickoff: "2026-06-01T20:00:00.000Z",
        },
        confirmedFacts: [
          "Both rows refer to Manchester United vs Chelsea.",
          "EPL and Premier League identify the same competition.",
        ],
        uncertainties: [],
        evidenceAssessment: {
          sameEvidence: 2,
          differentEvidence: 0,
          contradiction: false,
          noSource: false,
          notes: ["Sources [1] and [2] list the same fixture."],
        },
      }),
    );

    assert.equal(verdict.decision, "SAME");
    assert.deepEqual(verdict.canonicalEvent, {
      home: "Manchester United",
      away: "Chelsea",
      competition: "Premier League",
      kickoff: "2026-06-01T20:00:00.000Z",
    });
    assert.deepEqual(verdict.confirmedFacts, [
      "Both rows refer to Manchester United vs Chelsea.",
      "EPL and Premier League identify the same competition.",
    ]);
    assert.deepEqual(verdict.uncertainties, []);
    assert.deepEqual(verdict.evidenceAssessment, {
      sameEvidence: 2,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Sources [1] and [2] list the same fixture."],
    });
  });

  it("falls back to an explicit no-source evidence assessment", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "UNCERTAIN",
        confidence: 50,
        reasoning: "No evidence",
        canonicalEvent: null,
        confirmedFacts: [],
        uncertainties: ["No reliable source confirmed the fixture."],
      }),
    );

    assert.deepEqual(verdict.evidenceAssessment, {
      sameEvidence: 0,
      differentEvidence: 0,
      contradiction: false,
      noSource: true,
      notes: ["No usable search evidence was available."],
    });
  });

  it("preserves malformed search-backed DIFFERENT evidence for auto-reject policy", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "DIFFERENT",
        confidence: 100,
        reasoning:
          "Teams and competitions are different per multiple sources [1-7]. No overlap.",
        canonicalEvent: null,
        confirmedFacts: [
          "Event A is Deportivo La Guaira vs Academia Puerto Cabello.",
          "Event B is San Marcos vs Deportes Temuco.",
        ],
        uncertainties: [],
        evidenceAssessment:
          "Multiple reliable sources confirm distinct matches in different countries and leagues.",
      }),
      {
        evidence: [
          {
            title: "Fixture A",
            url: "https://example.com/a",
            snippet: "Deportivo La Guaira vs Academia Puerto Cabello",
            source: "test",
          },
          {
            title: "Fixture B",
            url: "https://example.com/b",
            snippet: "San Marcos vs Deportes Temuco",
            source: "test",
          },
        ],
      },
    );

    assert.equal(verdict.decision, "DIFFERENT");
    assert.deepEqual(verdict.evidenceAssessment, {
      sameEvidence: 0,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: [
        "Structured evidence assessment was malformed; search-backed DIFFERENT verdict was preserved for policy routing.",
      ],
    });
  });

  it("recovers malformed source-backed SAME evidence for matcher policy", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "SAME",
        confidence: 95,
        reasoning:
          "Exact same date/kickoff, same opponents, same league. Team name variant.",
        canonicalEvent: {
          homeTeam: "Hassania Agadir",
          awayTeam: "FUS Rabat",
          competition: "Botola Pro",
          kickoff: "2026-06-04T18:00:00Z",
        },
        confirmedFacts: [
          "Same kickoff UTC timestamp",
          "Same opponents (Hassania Agadir vs FUS Rabat)",
          "Same competition (Botola Pro)",
        ],
        uncertainties: [],
        evidenceAssessment:
          "Multiple sources (LiveScore, Flashscore, FotMob) confirm the fixture on June 4, 2026 at 18:00 UTC.",
      }),
      {
        evidence: [
          {
            title: "Football Live Scores & Fixtures | 4 June 2026",
            url: "https://www.livescore.com/en/football/2026-06-04/",
            snippet: "Botola Pro. Hassania Agadir. FUS Rabat.",
            source: "test",
          },
          {
            title: "Hassania Agadir v FUS Rabat fixtures",
            url: "https://www.flashscore.com/match/example/",
            snippet: "Hassania Agadir v FUS Rabat 04.06.2026.",
            source: "test",
          },
        ],
      },
    );

    assert.equal(verdict.decision, "SAME");
    assert.deepEqual(verdict.evidenceAssessment, {
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: [
        "Structured evidence assessment was malformed; source-backed SAME verdict text was recovered for policy routing.",
      ],
    });
  });

  it("normalizes noSource=false when evidence counts are present", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "SAME",
        confidence: 95,
        reasoning:
          "Same teams, same kickoff, and same competition. Web evidence does not contradict.",
        canonicalEvent: {
          homeTeam: "Club Atletico Juventud",
          awayTeam: "Club Sportivo Limpeno",
          competition: "Paraguayan Cup",
          kickoff: "2026-06-04T21:00:00Z",
        },
        confirmedFacts: ["Both events on 04 Jun 2026 at 21:00 UTC"],
        uncertainties: [],
        evidenceAssessment: {
          sameEvidence: 2,
          differentEvidence: 0,
          contradiction: false,
          noSource: true,
          notes: [],
        },
      }),
      {
        evidence: [
          {
            title: "Juventud vs Sportivo Limpeno",
            url: "https://example.com/juventud-limpeno",
            snippet: "Paraguayan Cup fixture",
            source: "test",
          },
        ],
      },
    );

    assert.equal(verdict.evidenceAssessment?.noSource, false);
    assert.equal(verdict.evidenceAssessment?.sameEvidence, 2);
    assert.deepEqual(verdict.evidenceAssessment?.notes, [
      "Model marked noSource despite source-backed evidence counts; normalized for policy routing.",
    ]);
  });

  it("extracts source-backed aliases from old source slugs and current titles", async () => {
    const hooks = await getHooks();
    const eventA = {
      homeTeam: "Cong An Ha Noi",
      awayTeam: "Becamex HCMC",
      competition: "Vietnam - V League",
      startTime: "2026-05-31T11:00:00.000Z",
    };
    const eventB = {
      homeTeam: "Cong An Nhan Dan",
      awayTeam: "Becamex Binh Duong",
      competition: "Vietnamese V-League",
      startTime: "2026-05-31T11:00:00.000Z",
    };

    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "DIFFERENT",
        confidence: 95,
        reasoning: "Raw team labels differ.",
        canonicalEvent: null,
        confirmedFacts: [],
        uncertainties: [],
        evidenceAssessment: {
          sameEvidence: 0,
          differentEvidence: 2,
          contradiction: false,
          noSource: false,
          notes: ["Model trusted raw provider labels."],
        },
      }),
      {
        eventA,
        eventB,
        evidence: [
          {
            title: "Cong An Ha Noi FC - Squad statistics - Transfermarkt",
            url: "https://www.transfermarkt.com/clb-cong-an-nhan-dan/leistungsdaten/verein/81455",
            snippet: "Cong An Ha Noi FC. V.League 1 League level.",
            source: "test",
          },
          {
            title: "Becamex Ho Chi Minh City FC - Schedule 25/26",
            url: "https://www.transfermarkt.com/becamex-binh-duong-fc/spielplan/verein/10756/saison_id/2025",
            snippet: "Becamex Ho Chi Minh City FC. Cong An Ha Noi FC.",
            source: "test",
          },
        ],
      },
    );

    assert.deepEqual(
      verdict.aliasEvidence.map((e) => e.side),
      ["home", "away"],
    );
  });

  it("extracts aliases when the current label is in the URL and old label is in the title", async () => {
    const hooks = await getHooks();
    const aliases = hooks.extractSourceBackedAliasEvidence(
      {
        homeTeam: "Metro United",
        awayTeam: "Harbor FC",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      {
        homeTeam: "Metro City",
        awayTeam: "Harbor",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      [
        {
          title: "Metro United - Club profile",
          url: "https://example.com/football/teams/metro-city/profile",
          snippet: "Metro United competes in the Premier League.",
          source: "test",
        },
      ],
    );

    assert.equal(aliases.length, 1);
    assert.equal(aliases[0].side, "home");
  });

  it("handles common abbreviation expansion and club suffix noise", async () => {
    const hooks = await getHooks();
    const aliases = hooks.extractSourceBackedAliasEvidence(
      {
        homeTeam: "Becamex HCMC",
        awayTeam: "River Club FC",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      {
        homeTeam: "Becamex Ho Chi Minh City FC",
        awayTeam: "River",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      [
        {
          title: "Becamex Ho Chi Minh City FC - Schedule",
          url: "https://example.com/clubs/becamex-hcmc/schedule",
          snippet: "Becamex Ho Chi Minh City FC fixtures.",
          source: "test",
        },
      ],
    );

    assert.equal(aliases.length, 0);
  });

  it("does not create aliases from snippets alone without URL-title agreement", async () => {
    const hooks = await getHooks();
    const aliases = hooks.extractSourceBackedAliasEvidence(
      {
        homeTeam: "Metro United",
        awayTeam: "Harbor FC",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      {
        homeTeam: "Metro City",
        awayTeam: "Harbor",
        competition: "Premier League",
        startTime: "2026-06-01T12:00:00.000Z",
      },
      [
        {
          title: "Premier League fixtures",
          url: "https://example.com/fixtures",
          snippet:
            "Metro United, also searched as Metro City, appears in fixtures.",
          source: "test",
        },
      ],
    );

    assert.deepEqual(aliases, []);
  });

  it("does not treat opponent fixture pages as alias proof", async () => {
    const hooks = await getHooks();
    const aliases = hooks.extractSourceBackedAliasEvidence(
      {
        homeTeam: "Cong An Ha Noi",
        awayTeam: "Becamex HCMC",
        competition: "Vietnam - V League",
        startTime: "2026-05-31T11:00:00.000Z",
      },
      {
        homeTeam: "PVF-Cong An Nhan Dan",
        awayTeam: "Hai Phong",
        competition: "Vietnamese V-League",
        startTime: "2026-05-31T11:00:00.000Z",
      },
      [
        {
          title: "PVF-Công An Nhân Dân vs Công An Hà Nội live score",
          url: "https://www.sofascore.com/football/match/pvf-cong-an-nhan-dan-cong-an-ha-noi/qxCbsqjLd",
          snippet:
            "PVF-Công An Nhân Dân is going head to head with Công An Hà Nội.",
          source: "test",
        },
      ],
    );

    assert.deepEqual(aliases, []);
  });

  it("attaches search failure diagnostics to valid entity-match JSON", async () => {
    const hooks = await getHooks();
    const verdict = hooks.parseMatchVerdict(
      JSON.stringify({
        decision: "UNCERTAIN",
        confidence: 55,
        reasoning: "search evidence was too thin",
        canonicalEvent: null,
        confirmedFacts: [],
        uncertainties: ["No reliable source confirmed both team labels."],
      }),
      {
        searchDiagnostics: {
          searchQueryCount: 4,
          searchFailureCount: 3,
          searchProvidersUsed: ["vertex", "none"],
        },
      },
    );

    assert.equal(verdict.diagnostics?.searchFailureRate, 0.75);
    assert.equal(verdict.diagnostics?.searchFailureCount, 3);
    assert.deepEqual(verdict.diagnostics?.searchProvidersUsed, [
      "vertex",
      "none",
    ]);
  });

  it("recovers partial batch verdicts", async () => {
    const hooks = await getHooks();
    const result = hooks.parseBatchVerdict(
      `{"verdicts":[{"pair":1,"decision":"DIFFERENT","confidence":95,"reasoning":"B team differs"`,
      1,
      { finishReason: "length" },
    );

    assert.equal(result.verdicts[0].pairIndex, 0);
    assert.equal(result.verdicts[0].decision, "DIFFERENT");
    assert.equal(result.verdicts[0].confidence, 95);
    assert.deepEqual(result.verdicts[0].diagnostics, {
      parseStatus: "recovered",
      finishReason: "length",
      warning: "Recovered fields from a truncated AI JSON response.",
    });
  });

  it("builds official-source drilldown queries for residual matching", async () => {
    const { buildMatchQueries } = await import("./grounding");
    const queries = buildMatchQueries(
      {
        homeTeam: "Inter Milan",
        awayTeam: "Bologna",
        competition: "Italian Serie A",
        startTime: "2026-05-23T16:00:00.000Z",
      },
      {
        homeTeam: "Internazionale",
        awayTeam: "Bologna FC",
        competition: "Serie A",
        startTime: "2026-05-23T16:00:00.000Z",
      },
    );

    assert(queries.length >= 8);
    assert(
      queries.some((q) => /2026-05-23 16:00 UTC/i.test(q)),
      "automated search queries should use UTC kickoff time",
    );
    assert(
      queries.every((q) => !/\bBDT\b|Asia\/Dhaka/i.test(q)),
      "automated search queries should not use operator-local time",
    );
    assert(queries.some((q) => /site:espn\.com\/soccer/i.test(q)));
    assert(queries.some((q) => /site:sofascore\.com/i.test(q)));
    assert.equal(
      new Set(queries.map((q) => q.toLowerCase())).size,
      queries.length,
    );
  });
});
