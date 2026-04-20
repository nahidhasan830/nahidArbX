import axios from "axios";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.sofascore.com/",
};

async function main(): Promise<void> {
  // Grab a finished match ID from today first
  const today = new Date().toISOString().slice(0, 10);
  const list = await axios.get(
    `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${today}`,
    { headers: HEADERS, timeout: 15_000 },
  );
  const finished = (list.data.events ?? []).filter(
    (e: { status: { type: string } }) => e.status.type === "finished",
  );
  const sample = finished[0];
  if (!sample) {
    console.log("no finished match");
    return;
  }
  console.log(
    `Sample: ${sample.homeTeam.name} vs ${sample.awayTeam.name} (id=${sample.id})`,
  );

  // Try statistics endpoint
  const urls = [
    `https://api.sofascore.com/api/v1/event/${sample.id}/statistics`,
    `https://api.sofascore.com/api/v1/event/${sample.id}`,
  ];
  for (const url of urls) {
    console.log(`\nGET ${url}`);
    try {
      const { data } = await axios.get(url, {
        headers: HEADERS,
        timeout: 15_000,
      });
      // Dig for corners
      const json = JSON.stringify(data);
      const cornerIdx = json.toLowerCase().indexOf("corner");
      if (cornerIdx >= 0) {
        console.log(
          "  Contains 'corner' at idx",
          cornerIdx,
          ":",
          json.slice(Math.max(0, cornerIdx - 30), cornerIdx + 200),
        );
      } else {
        console.log("  No 'corner' field in response");
      }
    } catch (err) {
      const e = err as {
        response?: { status?: number };
        message?: string;
      };
      console.log(`  FAILED ${e.response?.status}: ${e.message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
