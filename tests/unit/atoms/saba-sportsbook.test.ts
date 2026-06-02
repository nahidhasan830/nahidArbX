import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { SabaSportsbookAtomsAdapter } from "@/lib/atoms/adapters/saba-sportsbook";
import { clearAllOdds, getOdds } from "@/lib/atoms/store";

describe("SabaSportsbookAtomsAdapter", () => {
  beforeEach(() => {
    clearAllOdds();
  });

  afterEach(() => {
    clearAllOdds();
  });

  it("ignores odds rows for other Saba match IDs in the same socket snapshot", () => {
    const adapter = new SabaSportsbookAtomsAdapter();

    const count = adapter.processRawOdds(
      {
        rows: [
          {
            type: "o",
            matchid: 128213963,
            bettype: 5,
            oddsstatus: "running",
            enable: 1,
            com1: 1.55,
            comx: 3.65,
            com2: 4.95,
          },
          {
            type: "o",
            matchid: 128312923,
            bettype: 5,
            oddsstatus: "running",
            enable: 1,
            com1: 1.37,
            comx: 8.7,
            com2: 3.65,
          },
        ],
      },
      {
        providerEventId: "128213963",
        normalizedEventId: "event-canada-uzbekistan",
        homeTeam: "Canada",
        awayTeam: "Uzbekistan",
        options: {},
      },
    );

    expect(count).toBe(3);
    expect(
      getOdds(
        "event-canada-uzbekistan",
        "ft_match_result",
        "ft_draw",
        "saba-sportsbook",
      )?.odds,
    ).toBe(3.65);
  });

  it("maps Saba handicap signs from the home team's perspective", () => {
    const adapter = new SabaSportsbookAtomsAdapter();

    const count = adapter.processRawOdds(
      {
        rows: [
          {
            type: "o",
            matchid: 128213963,
            bettype: 1,
            hdp1: 0.25,
            oddsstatus: "running",
            enable: 1,
            odds1a: 0.37,
            odds2a: -0.53,
          },
        ],
      },
      {
        providerEventId: "128213963",
        normalizedEventId: "event-canada-uzbekistan",
        homeTeam: "Canada",
        awayTeam: "Uzbekistan",
        options: {},
      },
    );

    expect(count).toBe(2);
    expect(
      getOdds(
        "event-canada-uzbekistan",
        "ft_ah_m0_25",
        "ft_home_ah_m0_25",
        "saba-sportsbook",
      )?.odds,
    ).toBe(1.37);
    expect(
      getOdds(
        "event-canada-uzbekistan",
        "ft_ah_m0_25",
        "ft_away_ah_p0_25",
        "saba-sportsbook",
      )?.odds,
    ).toBeCloseTo(2.887, 3);
  });

  it("maps each supported Saba football market to the expected atom family", () => {
    const adapter = new SabaSportsbookAtomsAdapter();
    const eventId = "event-supported-markets";

    const count = adapter.processRawOdds(
      {
        rows: [
          {
            type: "o",
            matchid: 1,
            bettype: 2,
            oddsstatus: "running",
            enable: 1,
            odds1a: 0.91,
            odds2a: -0.91,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 3,
            hdp1: 2.5,
            oddsstatus: "running",
            enable: 1,
            odds1a: 0.79,
            odds2a: -0.97,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 5,
            oddsstatus: "running",
            enable: 1,
            com1: 1.55,
            comx: 3.65,
            com2: 4.95,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 7,
            hdp1: 0.25,
            oddsstatus: "running",
            enable: 1,
            odds1a: 0.72,
            odds2a: -0.9,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 8,
            hdp1: 1,
            oddsstatus: "running",
            enable: 1,
            odds1a: 0.91,
            odds2a: 0.89,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 15,
            oddsstatus: "running",
            enable: 1,
            com1: 2.12,
            comx: 2.21,
            com2: 5.1,
          },
          {
            type: "o",
            matchid: 1,
            bettype: 24,
            oddsstatus: "running",
            enable: 1,
            com1: 1.09,
            comx: 1.18,
            com2: 2.1,
          },
        ],
      },
      {
        providerEventId: "1",
        normalizedEventId: eventId,
        homeTeam: "Home",
        awayTeam: "Away",
        options: {},
      },
    );

    expect(count).toBe(17);
    expect(
      getOdds(eventId, "ft_odd_even", "ft_goals_odd", "saba-sportsbook")
        ?.odds,
    ).toBe(1.91);
    expect(
      getOdds(eventId, "ft_odd_even", "ft_goals_even", "saba-sportsbook")
        ?.odds,
    ).toBeCloseTo(2.099, 3);
    expect(
      getOdds(eventId, "ft_total_2_5", "ft_total_over_2_5", "saba-sportsbook")
        ?.odds,
    ).toBe(1.79);
    expect(
      getOdds(
        eventId,
        "ft_total_2_5",
        "ft_total_under_2_5",
        "saba-sportsbook",
      )?.odds,
    ).toBeCloseTo(2.031, 3);
    expect(
      getOdds(eventId, "ft_match_result", "ft_home_win", "saba-sportsbook")
        ?.odds,
    ).toBe(1.55);
    expect(
      getOdds(eventId, "ft_match_result", "ft_draw", "saba-sportsbook")
        ?.odds,
    ).toBe(3.65);
    expect(
      getOdds(eventId, "ft_match_result", "ft_away_win", "saba-sportsbook")
        ?.odds,
    ).toBe(4.95);
    expect(
      getOdds(eventId, "1h_ah_m0_25", "1h_home_ah_m0_25", "saba-sportsbook")
        ?.odds,
    ).toBe(1.72);
    expect(
      getOdds(eventId, "1h_ah_m0_25", "1h_away_ah_p0_25", "saba-sportsbook")
        ?.odds,
    ).toBeCloseTo(2.111, 3);
    expect(
      getOdds(eventId, "1h_total_1", "1h_total_over_1", "saba-sportsbook")
        ?.odds,
    ).toBe(1.91);
    expect(
      getOdds(eventId, "1h_total_1", "1h_total_under_1", "saba-sportsbook")
        ?.odds,
    ).toBe(1.89);
    expect(
      getOdds(eventId, "1h_match_result", "1h_home_win", "saba-sportsbook")
        ?.odds,
    ).toBe(2.12);
    expect(
      getOdds(eventId, "1h_match_result", "1h_draw", "saba-sportsbook")?.odds,
    ).toBe(2.21);
    expect(
      getOdds(eventId, "1h_match_result", "1h_away_win", "saba-sportsbook")
        ?.odds,
    ).toBe(5.1);
    expect(getOdds(eventId, "ft_double_chance", "ft_dc_1x", "saba-sportsbook")?.odds).toBe(1.09);
    expect(getOdds(eventId, "ft_double_chance", "ft_dc_12", "saba-sportsbook")?.odds).toBe(1.18);
    expect(getOdds(eventId, "ft_double_chance", "ft_dc_x2", "saba-sportsbook")?.odds).toBe(2.1);
  });
});
