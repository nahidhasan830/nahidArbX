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

function malformedEvidenceAssessment(
  text: string,
): DeepSeekResidualDecision["evidenceAssessment"] {
  return text as unknown as DeepSeekResidualDecision["evidenceAssessment"];
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

    expect(policyFromDeepSeek(residual(89), [], score(), config).decision).toBe(
      "human_review",
    );
    expect(policyFromDeepSeek(residual(90), [], score(), config).decision).toBe(
      "auto_reject",
    );
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

  it("auto-merges strong source-backed swapped rows when grounded review says SAME", () => {
    const decision = policyFromDeepSeek(
      sourcedSame({
        sameEvidence: 2,
        differentEvidence: 0,
        contradiction: false,
        noSource: false,
        notes: ["Sources [1] and [2] support SAME."],
      }),
      [],
      {
        ...score(),
        home: 0.45,
        away: 0.5,
        swappedHome: 1,
        swappedAway: 1,
        sameOrientationTeam: 0.475,
        swappedOrientationTeam: 1,
        bestTeam: 1,
        orientation: "swapped",
        competition: 0.95,
        combined: 0.95,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.stage).toBe("deepseek");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
    expect(decision.groundedDecision).toBe("SAME");
  });

  it("keeps weak swapped SAME verdicts in review without score support", () => {
    const decision = policyFromDeepSeek(
      sourcedSame({
        sameEvidence: 2,
        differentEvidence: 0,
        contradiction: false,
        noSource: false,
        notes: ["Sources support SAME."],
      }),
      [],
      {
        ...score(),
        home: 0.45,
        away: 0.5,
        swappedHome: 0.88,
        swappedAway: 0.72,
        sameOrientationTeam: 0.475,
        swappedOrientationTeam: 0.8,
        bestTeam: 0.8,
        orientation: "swapped",
        competition: 0.55,
        combined: 0.84,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("llm_uncertain");
    expect(decision.groundedDecision).toBe("SAME");
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

  it("auto-merges grounded SAME when score support lands on a floating-point threshold", () => {
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
        home: 1,
        away: 0.7999999999999999,
        sameOrientationTeam: 0.8999999999999999,
        bestTeam: 0.8999999999999999,
        competition: 0.9364705882352942,
        embeddingTeam: 0.912640442359151,
        embeddingCompetition: 0.9707920948393176,
        combined: 0.8962845923793471,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("auto-merges FK-prefixed bookmaker names when DeepSeek agrees and sources do not conflict", () => {
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
        home: 0.917948717948718,
        away: 0.9764705882352941,
        sameOrientationTeam: 0.947209653092006,
        bestTeam: 0.947209653092006,
        competition: 0.8214683866857779,
        embeddingTeam: 0.8809725707677006,
        embeddingCompetition: 0.8483556996641434,
        alias: 0.9764705882352941,
        providerReliability: 0.77,
        combined: 0.874181221948267,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("auto-merges recovered SAME evidence when score agreement is strong", () => {
    const same = sourcedSame({
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: [
        "Structured evidence assessment was malformed; source-backed SAME verdict text was recovered for policy routing.",
      ],
    });
    same.confidence = 85;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.8346491228070176,
        away: 1,
        sameOrientationTeam: 0.9173245614035088,
        bestTeam: 0.9173245614035088,
        competition: 1,
        embeddingTeam: 0.8608330809087646,
        embeddingCompetition: 0.9324411557313903,
        combined: 0.904701754385965,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("auto-merges one noisy team label when sourced SAME has independent score support", () => {
    const same = sourcedSame({
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: [
        "Source evidence supports one fixture and one noisy provider label.",
      ],
    });
    same.confidence = 85;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.48,
        away: 1,
        sameOrientationTeam: 0.74,
        bestTeam: 0.74,
        competition: 0.87,
        alias: 1,
        embeddingTeam: 0.91,
        embeddingCompetition: 0.89,
        combined: 0.865,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.confidence).toBeCloseTo(0.865, 3);
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("keeps sourced SAME with a noisy team label in review when local support is too weak", () => {
    const same = sourcedSame({
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: [
        "Source evidence supports one fixture and one noisy provider label.",
      ],
    });
    same.confidence = 85;

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.62,
        away: 0.7,
        sameOrientationTeam: 0.66,
        bestTeam: 0.66,
        competition: 0.78,
        alias: 0.7,
        embeddingTeam: 0.81,
        embeddingCompetition: 0.84,
        combined: 0.775,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("llm_uncertain");
  });

  it("auto-merges low-confidence source-only SAME when local score consensus is very strong", () => {
    const same = sourcedSame({
      sameEvidence: 2,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["Sources support one fixture; one provider label appears noisy."],
    });
    same.confidence = 70;
    same.reasoning =
      "Same date, time, competition; source confirms one fixture and one provider name error.";

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 1,
        away: 0.83,
        sameOrientationTeam: 0.915,
        bestTeam: 0.915,
        competition: 0.99,
        embeddingTeam: 0.94,
        embeddingCompetition: 0.91,
        combined: 0.912,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.confidence).toBeCloseTo(0.912, 3);
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
  });

  it("does not treat negated contradiction wording as evidence conflict", () => {
    const same = sourcedSame({
      sameEvidence: 2,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: [],
    });
    same.reasoning =
      "Both entries have identical UTC kickoff, same teams, and same competition. Web evidence does not contradict.";

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 0.8235294117647058,
        away: 1,
        sameOrientationTeam: 0.9117647058823529,
        bestTeam: 0.9117647058823529,
        competition: 0.9714285714285714,
        embeddingTeam: 0.9522466983145339,
        embeddingCompetition: 0.9695574109964538,
        combined: 0.9186295796275675,
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

  it("auto-merges dominant SAME evidence when one noisy source is outweighed", () => {
    const same = sourcedSame({
      sameEvidence: 5,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: [
        "Most sources support one fixture; one stale source only repeats the noisy provider label.",
      ],
    });
    same.confidence = 86;
    same.reasoning =
      "Sources confirm one fixture; one provider label appears stale.";

    const decision = policyFromDeepSeek(
      same,
      [],
      {
        ...score(),
        home: 1,
        away: 0.83,
        sameOrientationTeam: 0.915,
        bestTeam: 0.915,
        competition: 0.99,
        embeddingTeam: 0.943,
        embeddingCompetition: 0.91,
        combined: 0.912,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_merge");
    expect(decision.confidence).toBeCloseTo(0.912, 3);
    expect(decision.reasonCode).toBe("grounded_llm_same_match");
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
    expect(decision.reasonCode).toBe("llm_uncertain");
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

  it("keeps malformed kickoff-conflict DIFFERENT evidence in human review", () => {
    const different = residual(95);
    different.reasoning =
      "Web evidence shows 14:00 UTC, while provider kickoff is 20:00, a >2h difference.";
    different.evidenceAssessment = malformedEvidenceAssessment(
      "Sources confirm a kickoff time difference between the provider row and source listing.",
    );

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

  it("auto-rejects malformed source-backed DIFFERENT assessment text", () => {
    const different = residual(100);
    different.reasoning =
      "Different teams and different competitions confirmed by sources.";
    different.confirmedFacts = [
      "MFK Ruzomberok U19 vs Dukla Banska Bystrica U19 is listed in the Slovakia U19 competition.",
      "SK Sigma Olomouc U19 vs FC Vysocina Jihlava U19 is listed in the Czech U19 competition.",
    ];
    different.evidenceAssessment = malformedEvidenceAssessment(
      "Multiple sources confirm two separate matches; no overlap in teams or competitions.",
    );

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.681,
        away: 0.582,
        sameOrientationTeam: 0.632,
        bestTeam: 0.632,
        competition: 1,
        embeddingTeam: 0.8705,
        embeddingCompetition: 1,
        combined: 0.848,
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

  it("auto-rejects separate source fixtures despite moderate swapped team overlap", () => {
    const different = residual(95);
    different.reasoning =
      "Web evidence confirms two separate matches: South Adelaide vs Adelaide Cobras and Adelaide Blue Eagles vs Adelaide Olympic.";
    different.confirmedFacts = [
      "South Adelaide vs Adelaide Cobras is listed as one fixture.",
      "Adelaide Blue Eagles vs Adelaide Olympic is listed as another fixture.",
    ];
    different.evidenceAssessment = {
      sameEvidence: 1,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: [
        "Sources confirm two separate fixtures; the shared kickoff is the only same-event signal.",
      ],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.3,
        away: 0.42,
        swappedHome: 0.7,
        swappedAway: 0.88,
        sameOrientationTeam: 0.36,
        swappedOrientationTeam: 0.79,
        bestTeam: 0.79,
        orientation: "swapped",
        competition: 1,
        embeddingTeam: 0.8404,
        embeddingCompetition: 1,
        combined: 0.852,
      },
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

  it("auto-rejects material team mismatches even when reasoning mentions timezone", () => {
    const different = residual(95);
    different.reasoning =
      "Teams and competitions differ; kickoff times also differ after timezone conversion.";
    different.confirmedFacts = [
      "Source [1] lists one match with different teams and competition.",
      "Source [2] lists the other match as a separate fixture.",
    ];
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 2,
      contradiction: false,
      noSource: false,
      notes: ["Sources identify separate fixtures with different teams."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.48,
        away: 0.49,
        sameOrientationTeam: 0.485,
        bestTeam: 0.65,
        competition: 0.86,
        embeddingTeam: 0.74,
        embeddingCompetition: 0.88,
        combined: 0.78,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("auto-rejects source-backed DIFFERENT when material teams and competitions differ", () => {
    const different = residual(95);
    different.reasoning =
      "Teams and competitions are clearly different; teams do not overlap.";
    different.evidenceAssessment = {
      sameEvidence: 1,
      differentEvidence: 3,
      contradiction: false,
      noSource: false,
      notes: ["Sources identify different teams and different competitions."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.66,
        away: 0.58,
        sameOrientationTeam: 0.62,
        bestTeam: 0.69,
        competition: 0.88,
        embeddingTeam: 0.82,
        embeddingCompetition: 0.92,
        combined: 0.84,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("auto-rejects source-backed DIFFERENT when one exact team slot masks a different club", () => {
    const different = residual(90);
    different.reasoning =
      "Home teams are different clubs: IF Karlstad Fotbollutveckling vs FBK Karlstad 2.";
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: ["Sources identify different clubs in the home team slot."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.7,
        away: 1,
        sameOrientationTeam: 0.85,
        bestTeam: 0.85,
        competition: 0.84,
        alias: 1,
        embeddingTeam: 0.874,
        embeddingCompetition: 0.962,
        combined: 0.866,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("auto_reject");
    expect(decision.reasonCode).toBe("grounded_llm_different_match");
  });

  it("keeps one-slot source-backed aliases in review instead of auto-rejecting", () => {
    const different = residual(90);
    different.reasoning =
      "Home teams differ and away teams match, confirmed by sources.";
    different.evidenceAssessment = {
      sameEvidence: 0,
      differentEvidence: 1,
      contradiction: false,
      noSource: false,
      notes: ["Model trusted raw provider labels."],
    };
    different.aliasEvidence = [
      {
        side: "home",
        eventASurface: "SIF",
        eventBSurface: "Sundom IF",
        canonicalSurface: "Sundom IF - Fixtures",
        sourceTitle: "Sundom IF - Fixtures",
        sourceUrl: "https://example.com/sif/sundom-if",
        reason:
          "Source URL slug contains one provider label while the page title uses the other label.",
      },
    ];

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.7,
        away: 1,
        sameOrientationTeam: 0.85,
        bestTeam: 0.85,
        competition: 0.84,
        alias: 1,
        embeddingTeam: 0.874,
        embeddingCompetition: 0.962,
        combined: 0.866,
      },
      DEFAULT_EVENT_MATCHER_CONFIG,
    );

    expect(decision.decision).toBe("human_review");
    expect(decision.reasonCode).toBe("source_alias_conflict");
  });

  it("auto-rejects DIFFERENT when sourced reasoning names material team and competition differences", () => {
    const different = residual(100);
    different.reasoning =
      "Different teams and competitions: Northside vs Riverside in League A vs Eastside vs Westside in League B.";
    different.evidenceAssessment = {
      sameEvidence: 1,
      differentEvidence: 0,
      contradiction: false,
      noSource: false,
      notes: ["The shared kickoff is the only same-event signal."],
    };

    const decision = policyFromDeepSeek(
      different,
      [],
      {
        ...score(),
        home: 0.47,
        away: 0.7,
        swappedHome: 0.56,
        swappedAway: 0.64,
        sameOrientationTeam: 0.59,
        swappedOrientationTeam: 0.6,
        bestTeam: 0.6,
        orientation: "swapped",
        competition: 0.52,
        embeddingTeam: 0.71,
        embeddingCompetition: 0.91,
        combined: 0.744,
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
