import { describe, it, expect } from "vitest";
import { mapNinewicketsSportsbookToAtom } from "../../lib/atoms/mappings/ninewickets-sportsbook";

describe("NineWickets Team Totals", () => {
  it("should map team totals correctly", () => {
    expect(
      mapNinewicketsSportsbookToAtom(
        "Kashiwa Reysol Team Total Goals Over/Under +0.5",
        "Over",
        "Kashiwa",
        "FC Tokyo",
        0,
      ),
    ).toBe("ft_home_over_0_5");

    expect(
      mapNinewicketsSportsbookToAtom(
        "Half-time FC Tokyo Team Total Goals Over/Under +1.5",
        "Under",
        "Kashiwa",
        "FC Tokyo",
        0,
      ),
    ).toBe("1h_away_under_1_5");
  });
});

describe("NineWickets Sportsbook Total Goals", () => {
  it("maps live total goals with spaced Over / Under names", () => {
    expect(
      mapNinewicketsSportsbookToAtom(
        "Total Goals Over / Under 2.50",
        "Over",
        "Dinamo Zagreb",
        "Lokomotiva Zagreb",
        2.5,
      ),
    ).toBe("ft_total_over_2_5");

    expect(
      mapNinewicketsSportsbookToAtom(
        "Total Goals Over / Under 3.50",
        "Under",
        "Dinamo Zagreb",
        "Lokomotiva Zagreb",
        3.5,
      ),
    ).toBe("ft_total_under_3_5");
  });

  it("maps compact FT Over/Under names from upcoming Genius markets", () => {
    expect(
      mapNinewicketsSportsbookToAtom(
        "Over/Under +2.5",
        "Over",
        "El-Ittihad",
        "Ismaily",
        2.5,
      ),
    ).toBe("ft_total_over_2_5");

    expect(
      mapNinewicketsSportsbookToAtom(
        "Over/Under +3",
        "Under",
        "El-Ittihad",
        "Ismaily",
        3,
      ),
    ).toBe("ft_total_under_3");
  });

  it("maps compact second-half Over/Under total names", () => {
    expect(
      mapNinewicketsSportsbookToAtom(
        "Second Half Total Goals Over/Under +1.5",
        "Over",
        "El-Ittihad",
        "Ismaily",
        1.5,
      ),
    ).toBe("2h_total_over_1_5");
  });
});
