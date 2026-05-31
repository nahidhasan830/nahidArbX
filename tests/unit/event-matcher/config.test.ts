import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventMatcherConfig } from "../../../lib/event-matcher/config";

describe("event matcher config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults deterministic auto-merge to 90 percent combined confidence", () => {
    const config = getEventMatcherConfig();

    expect(config.combinedAutoMergeThreshold).toBe(0.9);
    expect(config.residualHigh).toBe(0.9);
  });

  it("reads active threshold overrides from the environment", () => {
    vi.stubEnv("EVENT_MATCHER_TEAM_AUTO_MERGE_FLOOR", "0.91");
    vi.stubEnv("EVENT_MATCHER_TEAM_AUTO_REJECT_CEILING", "0.41");
    vi.stubEnv("EVENT_MATCHER_COMPETITION_AUTO_MERGE_FLOOR", "0.71");
    vi.stubEnv("EVENT_MATCHER_COMPETITION_REJECT_CEILING", "0.19");
    vi.stubEnv("EVENT_MATCHER_RESIDUAL_LOW", "0.66");
    vi.stubEnv("EVENT_MATCHER_RESIDUAL_HIGH", "0.88");
    vi.stubEnv("EVENT_MATCHER_DEEPSEEK_AUTO_MERGE_CONFIDENCE", "97");
    vi.stubEnv("EVENT_MATCHER_DEEPSEEK_AUTO_REJECT_CONFIDENCE", "91");

    const config = getEventMatcherConfig();

    expect(config.teamAutoMergeFloor).toBe(0.91);
    expect(config.teamAutoRejectCeiling).toBe(0.41);
    expect(config.competitionAutoMergeFloor).toBe(0.71);
    expect(config.competitionRejectCeiling).toBe(0.19);
    expect(config.residualLow).toBe(0.66);
    expect(config.residualHigh).toBe(0.88);
    expect(config.deepseekAutoMergeEnabled).toBe(true);
    expect(config.deepseekAutoMergeConfidence).toBe(97);
    expect(config.deepseekAutoRejectConfidence).toBe(91);
  });
});
