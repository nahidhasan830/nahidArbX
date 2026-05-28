import { describe, expect, it } from "vitest";

import { formatScopedMarketText } from "@/components/ui/market-display";

describe("formatScopedMarketText", () => {
  it("does not repeat a line already present in the market label", () => {
    expect(
      formatScopedMarketText({
        marketLabel: "Total Goals 3.75",
        familyLine: 3.75,
      }),
    ).toBe("Total Goals 3.75");
  });

  it("normalizes equivalent trailing line formatting before deduping", () => {
    expect(
      formatScopedMarketText({
        marketLabel: "Total Goals 3.50",
        familyLine: 3.5,
      }),
    ).toBe("Total Goals 3.50");
  });

  it("still appends the line when the market label does not include it", () => {
    expect(
      formatScopedMarketText({
        marketLabel: "Total Goals",
        familyLine: 4,
      }),
    ).toBe("Total Goals 4");
  });

  it("formats market type, line, and selection together", () => {
    expect(
      formatScopedMarketText({
        marketType: "TOTAL_GOALS",
        familyLine: 4,
        selection: "ft_total_over_4",
      }),
    ).toBe("Total Goals 4 · Over 4");
  });
});
