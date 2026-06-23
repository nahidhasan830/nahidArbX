import { describe, it, expect } from "vitest";
import { deduplicateById, deduplicateBy } from "@/lib/shared/deduplication";

describe("deduplicateById", () => {
  it("returns empty array for empty input", () => {
    expect(deduplicateById([])).toEqual([]);
  });

  it("returns single item unchanged", () => {
    const items = [{ id: "a", value: 1 }];
    expect(deduplicateById(items)).toEqual(items);
  });

  it("deduplicates by id — later item wins", () => {
    const items = [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { id: "a", value: 3 },
    ];
    const result = deduplicateById(items);
    expect(result).toHaveLength(2);
    const aItem = result.find((x) => x.id === "a");
    expect(aItem?.value).toBe(3);
  });

  it("preserves all unique items", () => {
    const items = [
      { id: "x", v: 1 },
      { id: "y", v: 2 },
      { id: "z", v: 3 },
    ];
    expect(deduplicateById(items)).toHaveLength(3);
  });

  it("handles all duplicates — returns single item", () => {
    const items = [
      { id: "same", v: 1 },
      { id: "same", v: 2 },
      { id: "same", v: 3 },
    ];
    const result = deduplicateById(items);
    expect(result).toHaveLength(1);
    expect(result[0].v).toBe(3);
  });
});

describe("deduplicateBy", () => {
  it("deduplicates by custom key function", () => {
    const items = [
      { name: "alice", score: 10 },
      { name: "bob", score: 20 },
      { name: "alice", score: 30 },
    ];
    const result = deduplicateBy(items, (x) => x.name);
    expect(result).toHaveLength(2);
    const alice = result.find((x) => x.name === "alice");
    expect(alice?.score).toBe(30);
  });

  it("returns empty array for empty input", () => {
    expect(deduplicateBy([], (x: { id: string }) => x.id)).toEqual([]);
  });

  it("works with composite key", () => {
    const items = [
      { a: 1, b: 2, v: "first" },
      { a: 1, b: 3, v: "second" },
      { a: 1, b: 2, v: "third" },
    ];
    const result = deduplicateBy(items, (x) => `${x.a}:${x.b}`);
    expect(result).toHaveLength(2);
    const dup = result.find((x) => x.a === 1 && x.b === 2);
    expect(dup?.v).toBe("third");
  });
});
