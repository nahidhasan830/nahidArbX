import { describe, expect, it } from "vitest";
import { isSabaSyntheticMarketFixture } from "@/lib/adapters/saba-filters";

describe("Saba filters", () => {
  it.each([
    {
      homeTeam: "Canada No.of Corners 80:01-90:00",
      awayTeam: "Bosnia-Herzegovina No.of Corners 80:01-90:00",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 10 MINS NUMBER OF CORNERS",
    },
    {
      homeTeam: "USA 00:00-15:00",
      awayTeam: "Paraguay 00:00-15:00",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS",
    },
    {
      homeTeam: "Canada Total Bookings 30:01-45:00",
      awayTeam: "Bosnia-Herzegovina Total Bookings 30:01-45:00",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS TOTAL BOOKINGS",
    },
    {
      homeTeam: "Canada",
      awayTeam: "Bosnia-Herzegovina",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - TOTAL CORNER & TOTAL GOAL",
    },
    {
      homeTeam: "Canada",
      awayTeam: "Bosnia-Herzegovina",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - TOTAL GOALS MINUTES",
    },
    {
      homeTeam: "France 1st Goal",
      awayTeam: "Senegal 1st Goal",
      competition:
        "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIALS GOAL",
    },
  ])("rejects Saba special market fixture %#", (fixture) => {
    expect(
      isSabaSyntheticMarketFixture({
        provider: "saba-sportsbook",
        ...fixture,
      }),
    ).toBe(true);
  });

  it("keeps ordinary Saba match fixtures", () => {
    expect(
      isSabaSyntheticMarketFixture({
        provider: "saba-sportsbook",
        homeTeam: "Atvidabergs",
        awayTeam: "Eskilsminne IF",
        competition: "SWEDEN ETTAN SOUTH",
      }),
    ).toBe(false);
  });

  it("does not classify non-Saba provider fixtures", () => {
    expect(
      isSabaSyntheticMarketFixture({
        provider: "pinnacle",
        homeTeam: "USA 00:00-15:00",
        awayTeam: "Paraguay 00:00-15:00",
        competition:
          "*WORLD CUP 2026 (IN CANADA, MEXICO & USA) - SPECIFIC 15 MINS",
      }),
    ).toBe(false);
  });
});
