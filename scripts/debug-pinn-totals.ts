import { fetchWithTokenRefresh } from "../lib/adapters/pinnacle/index";
import {
  PinnacleEventMarketsResponseSchema,
  SOCCER_SPORT_ID,
} from "../lib/adapters/pinnacle/schemas";
import { buildEventMarketsUrl } from "../lib/adapters/pinnacle/urls";

async function run() {
  const eventId = process.argv[2] || "1628305870";
  const url = buildEventMarketsUrl(eventId);
  const { data } = await fetchWithTokenRefresh(url, { timeout: 15000 });
  const parsed = PinnacleEventMarketsResponseSchema.parse(data);
  if (parsed.code !== 200) {
    console.log("API error");
    return;
  }

  for (const sport of parsed.data) {
    if (sport[0] !== SOCCER_SPORT_ID) continue;
    for (const league of sport[3]) {
      for (const event of league[2]) {
        console.log(`${event[2]} vs ${event[3]}\n`);
        for (const period of event[5]) {
          const periodType = period[3];
          if (!period[4]) continue;
          for (const mkt of period[5]) {
            if (mkt[4] !== "TOTAL_POINTS") continue;
            const outcomes = mkt[12] as [
              number | null,
              number | null,
              string,
              string,
              number | null,
            ][];
            const oddsStr = outcomes.map((o) => `${o[3]}=${o[0]}`).join(", ");
            const maxStake = mkt[6];
            console.log(
              `  [halfInd=${mkt[1]}] TOTAL_POINTS | period="${periodType}" | ` +
                `handicap=${mkt[13]} | maxStake=${maxStake} | ${oddsStr} | status=${mkt[16]}`,
            );
          }
        }
      }
    }
  }
}

run().catch(console.error);
