/**
 * Fire a demo bet:placed + bet:settled pair through the real notifier
 * so the Telegram formatting (HTML + blockquotes + URL buttons) can be
 * previewed end-to-end. Safe: only the notifier runs, no DB/book calls.
 *
 *   npx tsx scripts/demo-bet-notify.ts
 */
import "dotenv/config";
import { notify } from "../lib/notifier";

const kickoff = new Date(Date.now() + 2 * 3600_000 + 15 * 60_000).toISOString();
const placedAt = new Date(Date.now() - 3 * 3600_000).toISOString();
const demo = {
  homeTeam: "Arsenal",
  awayTeam: "Chelsea",
  competition: "English Premier League",
  sport: "soccer",
  eventStartTime: kickoff,
  marketType: "MATCH_RESULT",
  timeScope: "FT" as const,
  familyLine: null,
  atomLabel: "Home",
};

const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
const dashboardUrl = appUrl
  ? `${appUrl}/dashboard`
  : "http://localhost:3000/dashboard";

async function main() {
  console.log("→ sending bet:placed demo…");
  await notify({
    type: "bet:placed",
    at: new Date().toISOString(),
    provider: "ninewickets-sportsbook",
    providerDisplayName: "9W Sportsbook",
    eventName: `${demo.homeTeam} vs ${demo.awayTeam}`,
    competition: demo.competition,
    sport: demo.sport,
    eventStartTime: demo.eventStartTime,
    marketName: demo.marketType,
    selectionName: demo.atomLabel,
    timeScope: demo.timeScope,
    familyLine: demo.familyLine,
    stake: 250,
    odds: 2.15,
    currency: "BDT",
    mode: "manual",
    evPct: 4.8,
    kellyStake: 250,
    kellyFraction: 0.25,
    ticketId: "DEMO-0001",
    dashboardUrl,
  });
  console.log("✓ placed sent");

  await new Promise((r) => setTimeout(r, 1200));

  console.log("→ sending bet:settled demo (won)…");
  await notify({
    type: "bet:settled",
    at: new Date().toISOString(),
    provider: "ninewickets-sportsbook",
    providerDisplayName: "9W Sportsbook",
    eventName: `${demo.homeTeam} vs ${demo.awayTeam}`,
    competition: demo.competition,
    sport: demo.sport,
    marketName: demo.marketType,
    selectionName: demo.atomLabel,
    timeScope: demo.timeScope,
    familyLine: demo.familyLine,
    stake: 250,
    odds: 2.15,
    closingOdds: 1.95,
    placedAt,
    currency: "BDT",
    outcome: "won",
    pnl: 287.5,
    settledBySource: "sofascore",
    matchScore: {
      status: "FT",
      ftHome: 3,
      ftAway: 1,
      htHome: 1,
      htAway: 0,
    },
    dashboardUrl,
  });
  console.log("✓ settled (won) sent");

  await new Promise((r) => setTimeout(r, 1200));

  console.log("→ sending bet:settled demo (lost, AH)…");
  await notify({
    type: "bet:settled",
    at: new Date().toISOString(),
    provider: "ninewickets-sportsbook",
    providerDisplayName: "9W Sportsbook",
    eventName: "FK IMT Novi Beograd vs Mladost Lucani",
    competition: "Serbia - Super Liga",
    sport: "soccer",
    marketName: "ASIAN_HANDICAP",
    selectionName: "Home -1.25",
    timeScope: "FT",
    familyLine: "-1.25",
    stake: 5,
    odds: 2.75,
    closingOdds: 2.75,
    placedAt: new Date(Date.now() - 4 * 3600_000 - 15 * 60_000).toISOString(),
    currency: "BDT",
    outcome: "lost",
    pnl: -5,
    settledBySource: "sofascore",
    matchScore: {
      status: "FT",
      ftHome: 1,
      ftAway: 0,
      htHome: 0,
      htAway: 0,
    },
    dashboardUrl,
  });
  console.log("✓ settled (lost AH) sent");

  await new Promise((r) => setTimeout(r, 1200));

  console.log("→ sending bet:error demo…");
  await notify({
    type: "bet:error",
    at: new Date().toISOString(),
    provider: "ninewickets-sportsbook",
    eventName: `${demo.homeTeam} vs ${demo.awayTeam}`,
    marketName: "OVER_UNDER",
    selectionName: "Over 2.5",
    error:
      "Market has already started — 9W rejected the placement because in-play suspension was triggered 12s before our request",
  });
  console.log("✓ error sent");

  await new Promise((r) => setTimeout(r, 1200));

  console.log("→ sending system (warn) demo…");
  await notify({
    type: "system",
    at: new Date().toISOString(),
    severity: "warn",
    message:
      "Pinnacle token · refresh failed\nFalling back to cache",
  });
  console.log("✓ system warn sent");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
