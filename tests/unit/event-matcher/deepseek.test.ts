import { describe, expect, it } from "vitest";
import { DEFAULT_EVENT_MATCHER_CONFIG } from "../../../lib/event-matcher/config";
import { policyFromDeepSeek } from "../../../lib/event-matcher/deepseek";
import type {
  DeepSeekResidualDecision,
  ScoreBreakdown,
} from "../../../lib/event-matcher/types";

function score(): ScoreBreakdown {
  return {
    home: 0.8,
    away: 0.8,
    swappedHome: 0.1,
    swappedAway: 0.1,
    sameOrientationTeam: 0.8,
    swappedOrientationTeam: 0.1,
    bestTeam: 0.8,
    orientation: "same",
    competition: 0.55,
    kickoff: 1,
    kickoffExact: true,
    providerReliability: 0.9,
    alias: 0.8,
    metadata: 0,
    embeddingTeam: null,
    embeddingCompetition: null,
    combined: 0.8,
    diagnostics: {
      exactKickoff: true,
      providerPair: "a__b",
      providerHints: [],
    },
  };
}

function residual(confidence: number): DeepSeekResidualDecision {
  return {
    decision: "DIFFERENT",
    confidence,
    reasoning: "Grounded sources identify different fixtures.",
    canonicalEvent: null,
    confirmedFacts: [],
    uncertainties: [],
    evidenceAssessment: null,
    sources: [
      {
        url: "https://example.com/match",
        title: "Match",
        snippet: "Fixture listing",
      },
    ],
    searchQueriesUsed: [],
    model: "deepseek",
  };
}

function sourcedSame(
  assessment: DeepSeekResidualDecision["evidenceAssessment"],
): DeepSeekResidualDecision {
  return {
    decision: "SAME",
    confidence: 96,
    reasoning: "Sources identify both rows as one fixture.",
    canonicalEvent: {
      home: "Inter Milan",
      away: "Bologna",
      competition: "Serie A",
      kickoff: "2026-05-23T16:00:00.000Z",
    },
    confirmedFacts: ["Source [1] lists Inter Milan vs Bologna."],
    uncertainties: [],
    evidenceAssessment: assessment,
    sources: [
      {
        url: "https://example.com/match",
        title: "Match",
        snippet: "Fixture listing",
      },
    ],
    searchQueriesUsed: [],
    model: "deepseek",
  };
}

describe("policyFromDeepSeek", () => {
  it("uses configured DIFFERENT confidence for auto-reject", () => {
    const config = {
      ...DEFAULT_EVENT_MATCHER_CONFIG,
      deepseekAutoRejectConfidence: 90,
    };

    expect(
      policyFromDeepSeek(residual(89), [], score(), config).decision,
    ).toBe("human_review");
    expect(
      policyFromDeepSeek(residual(90), [], score(), config).decision,
    ).toBe("auto_reject");
  });

  it("does not trust sourced SAME when structured evidence is contradictory", () => {
    const decision = policyFromDeepSeek(
      sourcedSame({
        sameEvidence: 1,
        differentEvidence: 1,
        contradiction: true,
        noSource: false,
        notes: ["Source [1] supports SAME but source [2] supports DIFFERENT."],
      }),
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.stage).toBe("human_review");
    expect(decision.reasonCode).toBe("llm_evidence_conflict");
  });

  it("allows auto-merge only when structured source evidence supports SAME alone", () => {
    const decision = policyFromDeepSeek(
      sourcedSame({
        sameEvidence: 2,
        differentEvidence: 0,
        contradiction: false,
        noSource: false,
        notes: ["Sources [1] and [2] support SAME."],
      }),
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("auto-merges high-confidence grounded SAME when score and sources agree despite weak structured assessment", () => {
    const same = sourcedSame({
      sameEvidence: 0,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Structured evidence counts were not populated."],
    });
    same.confidence = 92;
    same.uncertainties = ["Competition label naming differs by provider."];

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 1,
        away: 1,
        sameOrientationTeam: 1,
        bestTeam: 1,
        competition: 0.5,
        embeddingTeam: 1,
        embeddingCompetition: 0.74,
        combined: 0.88,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("auto-merges bookmaker abbreviations when DeepSeek and embeddings agree", () => {
    const same = sourcedSame({
      sameEvidence: 0,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Structured evidence counts were not populated."],
    });
    same.confidence = 95;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.8128571428571428,
        away: 1,
        sameOrientationTeam: 0.9064285714285714,
        bestTeam: 0.9064285714285714,
        competition: 0.9213818860877684,
        embeddingTeam: 0.9499352600224079,
        embeddingCompetition: 0.9110606832433741,
        combined: 0.9043230359953681,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("keeps bookmaker abbreviations in review without strong embedding support", () => {
    const same = sourcedSame({
      sameEvidence: 0,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Structured evidence counts were not populated."],
    });
    same.confidence = 95;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.78,
        away: 1,
        sameOrientationTeam: 0.89,
        bestTeam: 0.89,
        competition: 0.93,
        embeddingTeam: 0.89,
        embeddingCompetition: 0.93,
        combined: 0.9,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
  });

  it("keeps grounded SAME in review when structured sources include different evidence", () => {
    const same = sourcedSame({
      sameEvidence: 1,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: ["One source supports a different fixture."],
    });
    same.confidence = 95;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 1,
        away: 1,
        sameOrientationTeam: 1,
        bestTeam: 1,
        competition: 0.9,
        embeddingTeam: 1,
        embeddingCompetition: 0.9,
        combined: 0.9,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
  });

  it("keeps grounded SAME in review when material uncertainty remains", () => {
    const same = sourcedSame({
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Source supports same teams."],
    });
    same.confidence = 95;
    same.uncertainties = ["Could not verify the away team identity."];

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 1,
        away: 1,
        sameOrientationTeam: 1,
        bestTeam: 1,
        competition: 0.9,
        embeddingTeam: 1,
        embeddingCompetition: 0.9,
        combined: 0.9,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("classifies no-source residuals explicitly", () => {
    const same = sourcedSame({
      sameEvidence: 0,
      differentEvidence: 0,
      contradiction: false,
      noSource: true,
      notes: ["No usable source evidence."],
    });
    same.sources = [];

    const decision = policyFromDeepSeek(
      same,
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("llm_no_source");
  });

  it("keeps kickoff-conflict DIFFERENT decisions in human review when parsed kickoff is exact", () => {
    const different = residual(95);
    different.reasoning =
      "Web evidence shows 14:00 UTC, while provider kickoff is 20:00, a >2h difference.";
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: ["Source [1] kickoff time conflicts with provider display."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("llm_time_zone_uncertain");
  });

  it("does not mistake team mismatch evidence for a kickoff conflict", () => {
    const different = residual(95);
    different.reasoning =
      "Away team mismatch: Canada vs Croatia. Evidence confirms England U20 vs Canada U20.";
    different.confirmedFacts = [
      "Both provider rows have exact kickoff 2026-06-03T16:00:00.000Z.",
    ];
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: ["Sources identify different away teams."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 1,
        away: 0.62,
        sameOrientationTeam: 0.81,
        bestTeam: 0.81,
        competition: 0.95,
        combined: 0.84,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("auto-rejects clean DIFFERENT decisions that only mention the same kickoff time", () => {
    const different = residual(100);
    different.reasoning =
      "Clear evidence shows two separate matches with different teams and competitions on same date/time.";
    different.confirmedFacts = [
      "Deportivo La Guaira vs Academia Puerto Cabello is a Venezuela Primera Division match.",
      "San Marcos vs Deportes Temuco is a Chilean Primera B match.",
      "Both matches are on 31 May 2026 at 00:00 UTC.",
    ];
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 12,
      contradiction: false,
      noSource: false,
      notes: [],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("auto-rejects high-confidence separate fixtures when same evidence is only shared kickoff noise", () => {
    const different = residual(100);
    different.reasoning =
      "Web evidence shows two separate matches with different teams and leagues.";
    different.confirmedFacts = [
      "KR Reykjavik vs KA Akureyri is an Urvalsdeild fixture.",
      "Leiknir Reykjavik vs HK Kopavogur is a 1. Deild fixture.",
      "Both fixtures share the same kickoff timestamp.",
    ];
    different.evidenceAssessment = {
      sameEvidence: 1,
      differentEvidence: 3,
      contradiction: false,
      noSource: false,
      notes: [
        "Sources support different teams and competitions; shared kickoff is the only overlap.",
      ],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.8421052631578947,
        away: 0.5984848484848485,
        sameOrientationTeam: 0.7202950558213717,
        bestTeam: 0.7202950558213717,
        competition: 0.8586813186813187,
        alias: 0.8421052631578947,
        embeddingTeam: 0.8623754518170912,
        embeddingCompetition: 0.8886953647568643,
        combined: 0.8341594689069873,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("auto-rejects separate fixtures when the source text says teams differ", () => {
    const different = residual(95);
    different.reasoning =
      "Teams differ: Strommen vs Sogndal and Egersund vs Stromsgodset are separate fixtures same date.";
    different.evidenceAssessment = {
      sameEvidence: 1,
      differentEvidence: 3,
      contradiction: false,
      noSource: false,
      notes: ["The shared kickoff date is the only same-event signal."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.5,
        away: 0.67,
        swappedHome: 0.85,
        swappedAway: 0.6,
        sameOrientationTeam: 0.59,
        swappedOrientationTeam: 0.73,
        bestTeam: 0.73,
        orientation: "swapped",
        competition: 1,
        embeddingTeam: 0.83,
        embeddingCompetition: 1,
        combined: 0.84,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("keeps DIFFERENT in review when source-backed aliases cover the differing team slots", () => {
    const different = residual(95);
    different.reasoning =
      "Home teams differ and away teams differ, confirmed by sources.";
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: ["Model trusted raw provider labels."],
    };
    different.aliasEvidence = [
      {
        side: "home",
        eventASurface: "Cong An Ha Noi",
        eventBSurface: "Cong An Nhan Dan",
        canonicalSurface: "Cong An Ha Noi FC - Squad statistics",
        sourceTitle: "Cong An Ha Noi FC - Squad statistics",
        sourceUrl:
          "https://www.transfermarkt.com/clb-cong-an-nhan-dan/leistungsdaten/verein/81455",
        reason:
          "Source URL slug contains one provider label while the page title uses the other label.",
      },
      {
        side: "away",
        eventASurface: "Becamex HCMC",
        eventBSurface: "Becamex Binh Duong",
        canonicalSurface: "Becamex Ho Chi Minh City FC - Schedule",
        sourceTitle: "Becamex Ho Chi Minh City FC - Schedule",
        sourceUrl:
          "https://www.transfermarkt.com/becamex-binh-duong-fc/spielplan/verein/10756",
        reason:
          "Source URL slug contains one provider label while the page title uses the other label.",
      },
    ];

    const decision = policyFromDeepSeek(
      different,
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("source_alias_conflict");
  });

  it("still auto-rejects DIFFERENT when alias evidence covers only one differing team slot", () => {
    const different = residual(95);
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: ["Away teams remain distinct."],
    };
    different.aliasEvidence = [
      {
        side: "home",
        eventASurface: "Old Metro",
        eventBSurface: "Metro United",
        canonicalSurface: "Metro United - Club profile",
        sourceTitle: "Metro United - Club profile",
        sourceUrl: "https://example.com/clubs/old-metro/profile",
        reason:
          "Source URL slug contains one provider label while the page title uses the other label.",
      },
    ];

    const decision = policyFromDeepSeek(
      different,
      [],
      score(),
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });
});
