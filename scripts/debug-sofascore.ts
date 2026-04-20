import axios from "axios";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.sofascore.com/",
  Origin: "https://www.sofascore.com",
};

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const url = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${date}`;
  console.log(`GET ${url}`);
  try {
    const { data } = await axios.get(url, {
      headers: HEADERS,
      timeout: 15_000,
    });
    const events = data.events ?? [];
    const finished = events.filter(
      (e: { status?: { type?: string } }) => e.status?.type === "finished",
    );
    console.log(`Got ${events.length} events, ${finished.length} finished.`);
    // Show a handful
    for (const e of finished.slice(0, 10)) {
      console.log(
        `  ${e.tournament?.name?.padEnd(35) || "?"} ${e.homeTeam.name} ${e.homeScore.current}-${e.awayScore.current} ${e.awayTeam.name} (HT ${e.homeScore.period1 ?? "?"}-${e.awayScore.period1 ?? "?"})`,
      );
    }
    // Tournament distribution
    const byTourn = new Map<string, number>();
    for (const e of finished) {
      const k = e.tournament?.name ?? "unknown";
      byTourn.set(k, (byTourn.get(k) ?? 0) + 1);
    }
    console.log("\nTop tournaments:");
    for (const [k, v] of [...byTourn.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)) {
      console.log(`  ${String(v).padStart(3)} ${k}`);
    }
  } catch (err) {
    const e = err as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    console.log("FAILED:", e.response?.status, e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
