/**
 * Probe Fotmob's matches-by-date endpoint. Goal: confirm it covers the
 * niche leagues SofaScore doesn't (Albania Superliga, Finland Ykkonen,
 * Thai League 2, Paraguay Intermedia, Slovakia 2. Liga). Also probe the
 * shape (HT/FT scores, team names) so the adapter can be built cleanly.
 */

import axios from "axios";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.fotmob.com/",
  Origin: "https://www.fotmob.com",
};

async function main(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://www.fotmob.com/api/matches?date=${date}`;
  console.log(`GET ${url}`);
  try {
    const { data, status, headers } = await axios.get(url, {
      headers: HEADERS,
      timeout: 20_000,
      validateStatus: () => true,
    });
    console.log(`status=${status}`);
    if (typeof data !== "object") {
      console.log("non-JSON response:", String(data).slice(0, 200));
      return;
    }
    const leagues: {
      primaryId?: number;
      name: string;
      ccode?: string;
      matches?: {
        id: string;
        home: { name: string };
        away: { name: string };
        status?: { finished?: boolean; reason?: { long?: string } };
        statusVariables?: unknown;
      }[];
    }[] = (data as { leagues?: unknown }).leagues as typeof leagues;
    console.log(`Got ${leagues?.length ?? 0} league groups.`);
    const targets = ["Albania", "Finland", "Thailand", "Paraguay", "Slovakia"];
    for (const l of leagues ?? []) {
      if (
        targets.some(
          (t) =>
            l.name.includes(t) ||
            (l.ccode ?? "").includes(t.slice(0, 3).toUpperCase()),
        )
      ) {
        console.log(
          `\n${l.ccode ?? "??"} ${l.name}: ${l.matches?.length ?? 0} matches`,
        );
        for (const m of l.matches?.slice(0, 3) ?? []) {
          console.log(`  • ${m.home.name} vs ${m.away.name}`);
        }
      }
    }
    console.log(`\nFirst 8 league names:`);
    for (const l of (leagues ?? []).slice(0, 8))
      console.log(`  ${l.ccode ?? "??"} ${l.name}`);
    console.log(
      `\nResponse top-level keys: ${Object.keys(data).slice(0, 10).join(", ")}`,
    );
    console.log(
      `Response headers of interest: x-mas=${headers["x-mas"] ?? ""}`,
    );
  } catch (err) {
    const e = err as { response?: { status?: number }; message?: string };
    console.log("FAILED:", e.response?.status, e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
