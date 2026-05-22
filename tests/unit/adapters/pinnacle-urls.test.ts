import { describe, expect, it, vi } from "vitest";
import { buildEventsUrl } from "@/lib/adapters/pinnacle/urls";

describe("buildEventsUrl", () => {
  it("includes the timezone segment required by Pinnacle's events route", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T12:34:56+06:00"));

    try {
      const url = buildEventsUrl();

      expect(url).toContain("/period-type/TODAY/");
      expect(url).toContain("/market-type/ALL/tz/");
      expect(url).toMatch(/\/tz\/(?:%2B|-)\d{2}%3A\d{2}\/from-date\//);
      expect(url).toContain("/from-date/2026-05-23T00:00:00/");
      expect(url).toContain("/to-date/2026-05-24T23:59:59/");
    } finally {
      vi.useRealTimers();
    }
  });
});
