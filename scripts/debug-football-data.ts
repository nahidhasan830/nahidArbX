/**
 * Quick probe against football-data.org — verifies the key works AND
 * shows exactly what the API returns for today's tier-1 matches so we
 * can see why the fuzzy matcher isn't resolving them.
 */

import axios from "axios";

async function main(): Promise<void> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) throw new Error("FOOTBALL_DATA_API_KEY not set");

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);

  const dateFrom = yesterday;
  const dateTo = today;

  // 1. All competitions in range
  console.log(`\n── GET /v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo} ──`);
  try {
    const { data, headers } = await axios.get(
      "https://api.football-data.org/v4/matches",
      {
        params: { dateFrom, dateTo },
        headers: { "X-Auth-Token": key },
        timeout: 15_000,
      },
    );
    console.log("Rate:", {
      requests: headers["x-requests-available-minute"],
      requestsCounter: headers["x-requestcounter-reset"],
    });
    const matches = data.matches ?? [];
    console.log(`${matches.length} matches returned.`);
    // Group by competition
    const byComp = new Map<string, number>();
    for (const m of matches) {
      const key = `${m.competition.code} ${m.competition.name}`;
      byComp.set(key, (byComp.get(key) ?? 0) + 1);
    }
    for (const [k, v] of [...byComp].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(40)} ${v}`);
    }
    // Show first 8 matches with team names
    console.log("\nSample matches:");
    for (const m of matches.slice(0, 8)) {
      console.log(
        `  ${m.homeTeam.name.padEnd(25)} vs ${m.awayTeam.name.padEnd(25)} | ${m.competition.code} | ${m.status} | FT ${m.score.fullTime.home}-${m.score.fullTime.away}`,
      );
    }
  } catch (err) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    console.log("FAILED:", e.response?.status, e.message, e.response?.data);
  }

  // 2. Narrowed to PL only
  console.log("\n── GET /v4/matches?competitions=PL ──");
  try {
    const { data } = await axios.get(
      "https://api.football-data.org/v4/matches",
      {
        params: { dateFrom, dateTo, competitions: "PL" },
        headers: { "X-Auth-Token": key },
        timeout: 15_000,
      },
    );
    const matches = data.matches ?? [];
    console.log(`${matches.length} PL matches today/yesterday.`);
    for (const m of matches.slice(0, 5)) {
      console.log(
        `  ${m.homeTeam.name} vs ${m.awayTeam.name} | ${m.status} | FT ${m.score.fullTime.home}-${m.score.fullTime.away}`,
      );
    }
  } catch (err) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    console.log("FAILED:", e.response?.status, e.message, e.response?.data);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
