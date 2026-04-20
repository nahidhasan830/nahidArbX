/**
 * Probe SofaScore for the specific events our pipeline couldn't resolve.
 * Checks: is the fixture actually in SofaScore's data? If so, what names
 * do they use? (Goal: decide whether further team-name tuning would help
 * or if the gap is genuinely unreachable.)
 */

import axios from "axios";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.sofascore.com/",
};

const TARGETS = [
  ["Egnatia Rrogozhine", "Flamurtari Vlore", "Albania"],
  ["VJS", "SalPa", "Finland Ykkonen"],
  ["Tampere United", "KuPS Akatemia", "Finland Ykkonen"],
  ["Gnistan", "HJK Helsinki", "Finland Veikkausliiga"],
  ["Pattani FC", "Chanthaburi", "Thailand L2"],
  ["Guairena", "Club Tacuary", "Paraguay"],
  ["Inter Bratislava", "Pohronie", "Slovakia L2"],
];

async function main(): Promise<void> {
  const date = "2026-04-18";
  console.log(`GET sport/football/scheduled-events/${date}`);
  const { data } = await axios.get(
    `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${date}`,
    { headers: HEADERS, timeout: 15_000 },
  );
  const events: {
    homeTeam: { name: string };
    awayTeam: { name: string };
    tournament?: { name?: string };
    status: { type: string };
    homeScore: { current?: number };
    awayScore: { current?: number };
  }[] = data.events ?? [];
  console.log(`Got ${events.length} events.`);

  for (const [h, a, label] of TARGETS) {
    const hits = events.filter((e) => {
      const hn = e.homeTeam.name.toLowerCase();
      const an = e.awayTeam.name.toLowerCase();
      return (
        hn.includes(h.toLowerCase().split(" ")[0]) ||
        an.includes(h.toLowerCase().split(" ")[0]) ||
        hn.includes(a.toLowerCase().split(" ")[0]) ||
        an.includes(a.toLowerCase().split(" ")[0])
      );
    });
    console.log(`\n── ${label}: ${h} vs ${a} ──`);
    if (hits.length === 0) {
      console.log(`  NOT FOUND in SofaScore data for ${date}`);
    } else {
      for (const e of hits.slice(0, 3)) {
        console.log(
          `  • ${e.tournament?.name ?? "?"}: ${e.homeTeam.name} ${e.homeScore.current}-${e.awayScore.current} ${e.awayTeam.name} [${e.status.type}]`,
        );
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
