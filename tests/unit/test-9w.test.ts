import { describe, it, expect } from "vitest";
import { mapNinewicketsSportsbookToAtom } from "../../lib/atoms/mappings/ninewickets-sportsbook";

describe("NineWickets Team Totals", () => {
  it("should map team totals correctly", () => {
    expect(
      mapNinewicketsSportsbookToAtom("Kashiwa Reysol Team Total Goals Over/Under +0.5", "Over", "Kashiwa", "FC Tokyo", 0)
    ).toBe("ft_home_over_0_5");

    expect(
      mapNinewicketsSportsbookToAtom("Second Half FC Tokyo Team Total Goals Over/Under +1.5", "Under", "Kashiwa", "FC Tokyo", 0)
    ).toBe("2h_away_under_1_5");
  });
});
