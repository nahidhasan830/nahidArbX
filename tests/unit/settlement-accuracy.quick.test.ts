import { describe, it, expect, beforeAll } from "vitest";
import { listBets } from "@/lib/db/repositories/bets";
import { getScoresByEventIds } from "@/lib/db/repositories/match-scores";

const BASE_URL = "http://localhost:3000";

async function isUp(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

describe("Quick Settlement Test", () => {
  it("checks services and fetches sample data", async () => {
    const up = await isUp(`${BASE_URL}/api/ai-search/healthz`);
    console.log(`Services up: ${up}`);
    expect(up).toBe(true);

    const { rows } = await listBets({ outcome: "settled", limit: 50 });
    console.log(`Fetched ${rows.length} settled bets`);

    const eventIds = [...new Set(rows.map((r) => r.eventId))];
    const scores = await getScoresByEventIds(eventIds);
    console.log(`Found scores for ${scores.size}/${eventIds.length} events`);

    const goalMarkets = new Set([
      "MATCH_RESULT", "OVER_UNDER", "TOTAL_GOALS", "ASIAN_HANDICAP",
      "BTTS", "DNB", "HOME_TEAM_TOTAL", "AWAY_TEAM_TOTAL",
      "DOUBLE_CHANCE", "EUROPEAN_HANDICAP",
    ]);

    const eligible = rows.filter((bet) => {
      const score = scores.get(bet.eventId);
      return score && score.status !== "ABD" && score.status !== "POSTPONED" && goalMarkets.has(bet.marketType);
    });

    console.log(`Eligible bets: ${eligible.length}`);
    if (eligible.length > 0) {
      const sample = eligible.slice(0, 2);
      for (const bet of sample) {
        const score = scores.get(bet.eventId)!;
        console.log(`  ${bet.homeTeam} vs ${bet.awayTeam} | ${bet.marketType} | ${score.ftHome}-${score.ftAway} | ${bet.outcome}`);
      }
    }
    expect(eligible.length).toBeGreaterThan(0);
  }, 30000);
});
