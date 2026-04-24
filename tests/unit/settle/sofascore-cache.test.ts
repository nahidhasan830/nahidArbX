import { describe, expect, it } from "vitest";
import {
  getDayEventsCacheTtlMs,
  shouldUseDayEventsCache,
} from "@/lib/settle/sources/sofascore";

describe("SofaScore day cache policy", () => {
  const now = Date.parse("2026-04-22T19:30:00.000Z");

  it("uses a short TTL for today", () => {
    expect(getDayEventsCacheTtlMs("2026-04-22", now)).toBe(2 * 60 * 1000);
  });

  it("uses a long TTL for historical dates", () => {
    expect(getDayEventsCacheTtlMs("2026-04-18", now)).toBe(24 * 60 * 60 * 1000);
  });

  it("expires same-day cache entries quickly so recent fixtures refetch", () => {
    const fetchedAt = now - 3 * 60 * 1000;
    expect(shouldUseDayEventsCache("2026-04-22", fetchedAt, now)).toBe(false);
  });

  it("reuses historical cache entries well past the live TTL", () => {
    const fetchedAt = now - 3 * 60 * 60 * 1000;
    expect(shouldUseDayEventsCache("2026-04-18", fetchedAt, now)).toBe(true);
  });
});
