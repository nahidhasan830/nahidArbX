/**
 * Probe ESPN's hidden scoreboard API. Verifies it returns finished
 * matches with scores for the leagues the user actually cares about.
 */

import axios from "axios";
import { format, subDays } from "date-fns";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

const SLUGS = [
  ["swe.1", "Allsvenskan"],
  ["swe.2", "Superettan"],
  ["ger.2", "2. Bundesliga"],
  ["ger.3", "3. Liga"],
  ["ita.2", "Serie B"],
  ["nor.1", "Eliteserien"],
  ["tur.1", "Super Lig"],
  ["rsa.1", "PSL"],
  ["srb.1", "Serbian SuperLiga"],
  ["rou.1", "Liga I"],
  ["hun.1", "NB I"],
  ["eng.1", "Premier League"],
  ["ger.1", "Bundesliga"],
  ["ita.1", "Serie A"],
] as const;

async function probe(slug: string, label: string): Promise<void> {
  const now = new Date();
  const today = format(now, "yyyyMMdd");
  const yesterday = format(subDays(now, 1), "yyyyMMdd");
  const url = `${BASE}/${slug}/scoreboard?dates=${yesterday}-${today}`;
  try {
    const { data } = await axios.get(url, { timeout: 10_000 });
    const events = data.events ?? [];
    const finished = events.filter(
      (e: { status?: { type?: { state?: string } } }) =>
        e.status?.type?.state === "post",
    );
    const first = finished[0];
    let sampleLine = "";
    if (first) {
      const comp = first.competitions?.[0];
      const home = comp?.competitors?.find(
        (c: { homeAway: string }) => c.homeAway === "home",
      );
      const away = comp?.competitors?.find(
        (c: { homeAway: string }) => c.homeAway === "away",
      );
      sampleLine = `  → ${home?.team?.displayName} ${home?.score} - ${away?.score} ${away?.team?.displayName}`;
    }
    console.log(
      `${slug.padEnd(10)} ${label.padEnd(20)} ${events.length} events, ${finished.length} finished`,
    );
    if (sampleLine) console.log(sampleLine);
  } catch (err) {
    console.log(
      `${slug.padEnd(10)} ${label.padEnd(20)} FAILED: ${(err as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`── ESPN hidden scoreboard probe ──\n`);
  for (const [slug, label] of SLUGS) {
    await probe(slug, label);
    await new Promise((r) => setTimeout(r, 120));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
