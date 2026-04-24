import { describe, it, expect } from "vitest";
import {
  normalizeOutcome,
  stakeFractionForOutcome,
  isSettledOutcome,
  hasPnl,
  OUTCOMES,
} from "@/lib/bets-history/types";

describe("normalizeOutcome", () => {
  it("passes through all valid outcomes unchanged", () => {
    const valid = ["won", "half_won", "lost", "half_lost", "void", "pending"];
    for (const o of valid) {
      expect(normalizeOutcome(o)).toBe(o);
    }
  });

  it("maps legacy 'push' to 'void'", () => {
    expect(normalizeOutcome("push")).toBe("void");
  });

  it("maps unknown string to 'pending'", () => {
    expect(normalizeOutcome("unknown_value")).toBe("pending");
    expect(normalizeOutcome("WIN")).toBe("pending");
    expect(normalizeOutcome("")).toBe("pending");
  });

  it("maps null and undefined to 'pending'", () => {
    expect(normalizeOutcome(null)).toBe("pending");
    expect(normalizeOutcome(undefined)).toBe("pending");
  });
});

describe("stakeFractionForOutcome", () => {
  it("full stake for won and lost", () => {
    expect(stakeFractionForOutcome("won")).toBe(1);
    expect(stakeFractionForOutcome("lost")).toBe(1);
  });

  it("half stake for half_won and half_lost", () => {
    expect(stakeFractionForOutcome("half_won")).toBe(0.5);
    expect(stakeFractionForOutcome("half_lost")).toBe(0.5);
  });

  it("zero stake for void and pending", () => {
    expect(stakeFractionForOutcome("void")).toBe(0);
    expect(stakeFractionForOutcome("pending")).toBe(0);
  });
});

describe("isSettledOutcome", () => {
  it("returns false for pending only", () => {
    expect(isSettledOutcome("pending")).toBe(false);
  });

  it("returns true for all non-pending outcomes", () => {
    const settled = ["won", "half_won", "lost", "half_lost", "void"] as const;
    for (const o of settled) {
      expect(isSettledOutcome(o)).toBe(true);
    }
  });
});

describe("hasPnl", () => {
  it("true for outcomes that affect P&L", () => {
    expect(hasPnl("won")).toBe(true);
    expect(hasPnl("half_won")).toBe(true);
    expect(hasPnl("lost")).toBe(true);
    expect(hasPnl("half_lost")).toBe(true);
  });

  it("false for void and pending", () => {
    expect(hasPnl("void")).toBe(false);
    expect(hasPnl("pending")).toBe(false);
  });
});

describe("OUTCOMES", () => {
  it("contains all 6 outcomes", () => {
    expect(OUTCOMES).toHaveLength(6);
    expect(OUTCOMES).toContain("pending");
    expect(OUTCOMES).toContain("won");
    expect(OUTCOMES).toContain("half_won");
    expect(OUTCOMES).toContain("lost");
    expect(OUTCOMES).toContain("half_lost");
    expect(OUTCOMES).toContain("void");
  });
});
