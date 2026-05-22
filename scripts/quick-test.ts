import { listBets } from "@/lib/db/repositories/bets";
import { getScoresByEventIds } from "@/lib/db/repositories/match-scores";

async function main() {
  const { rows } = await listBets({ outcome: "settled", limit: 50 });
  const eventIds = [...new Set(rows.map((r) => r.eventId))];
  const scores = await getScoresByEventIds(eventIds);
  const goalMarkets = new Set([
    "MATCH_RESULT",
    "OVER_UNDER",
    "TOTAL_GOALS",
    "ASIAN_HANDICAP",
    "BTTS",
    "DNB",
    "HOME_TEAM_TOTAL",
    "AWAY_TEAM_TOTAL",
    "DOUBLE_CHANCE",
    "EUROPEAN_HANDICAP",
  ]);
  const eligible = rows.filter((bet) => {
    const score = scores.get(bet.eventId);
    return (
      score &&
      score.status !== "ABD" &&
      score.status !== "POSTPONED" &&
      goalMarkets.has(bet.marketType)
    );
  });
  console.log(
    `Found ${eligible.length} eligible bets out of ${rows.length} settled`,
  );
  if (eligible.length > 0) {
    const sample = eligible.slice(0, 5);
    for (const bet of sample) {
      const score = scores.get(bet.eventId)!;
      console.log(
        `${bet.homeTeam} vs ${bet.awayTeam} | ${bet.marketType} | Actual: ${score.ftHome}-${score.ftAway} | Outcome: ${bet.outcome}`,
      );
    }
  }
}
main().catch(console.error);
