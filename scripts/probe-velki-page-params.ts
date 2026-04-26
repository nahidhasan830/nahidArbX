/**
 * Probe Velki's queryEventsWithMarket with various parameter tweaks
 * to find one that returns all events in a single response (no
 * pagination walk needed).
 *
 * Usage:  npx tsx scripts/probe-velki-page-params.ts
 */
import "dotenv/config";
import { getSession } from "../lib/betting/velki/session";

const HOST = "https://bkqawscf.fwick7ets.xyz";
const PATH = "/exchange/member/playerService/queryEventsWithMarket";
const ORIGIN = "https://www.fwick7ets.xyz";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function browserHeaders(jsessionid: string): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    source: "1",
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: jsessionid,
    Cookie: `JSESSIONID=${jsessionid}`,
  };
}

interface ProbeResult {
  name: string;
  body: Record<string, string>;
  status: number;
  topLevelKeys: string[];
  events: number;
  currentPage: number | null;
  lastPage: number | null;
  ok: boolean;
  note: string;
}

async function probe(
  jsessionid: string,
  name: string,
  body: Record<string, string>,
): Promise<ProbeResult> {
  const url = `${HOST}${PATH};jsessionid=${jsessionid}`;
  const res = await fetch(url, {
    method: "POST",
    headers: browserHeaders(jsessionid),
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    return {
      name,
      body,
      status: res.status,
      topLevelKeys: [],
      events: 0,
      currentPage: null,
      lastPage: null,
      ok: false,
      note: "HTML body (session dead?)",
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      name,
      body,
      status: res.status,
      topLevelKeys: [],
      events: 0,
      currentPage: null,
      lastPage: null,
      ok: false,
      note: `JSON parse failed: ${err instanceof Error ? err.message : err}`,
    };
  }
  const events = Array.isArray(parsed.events)
    ? (parsed.events as unknown[]).length
    : 0;
  return {
    name,
    body,
    status: res.status,
    topLevelKeys: Object.keys(parsed),
    events,
    currentPage:
      typeof parsed.currentPage === "number" ? parsed.currentPage : null,
    lastPage: typeof parsed.lastPage === "number" ? parsed.lastPage : null,
    ok: events > 0,
    note: "",
  };
}

async function main() {
  const session = await getSession();
  const jsessionid = session.jsessionid;

  const baseBody = {
    eventType: "1",
    eventTs: "-1",
    marketTs: "-1",
    selectionTs: "-1",
    viewType: "openDateTime",
    competitionId: "-1",
    pageNumber: "1",
  };

  const tests: Array<{ name: string; body: Record<string, string> }> = [
    { name: "current (baseline page 1)", body: { ...baseBody } },
    {
      name: "no pageNumber",
      body: (() => {
        const b = { ...baseBody } as Record<string, string>;
        delete b.pageNumber;
        return b;
      })(),
    },
    { name: "pageNumber=0", body: { ...baseBody, pageNumber: "0" } },
    { name: "pageNumber=-1", body: { ...baseBody, pageNumber: "-1" } },
    {
      name: "pageSize=500",
      body: { ...baseBody, pageSize: "500" },
    },
    {
      name: "pageSize=1000",
      body: { ...baseBody, pageSize: "1000" },
    },
    {
      name: "size=500",
      body: { ...baseBody, size: "500" },
    },
    {
      name: "limit=500",
      body: { ...baseBody, limit: "500" },
    },
    {
      name: "perPage=500",
      body: { ...baseBody, perPage: "500" },
    },
    {
      name: "rowsPerPage=500",
      body: { ...baseBody, rowsPerPage: "500" },
    },
    {
      name: "pageNum=1 + pageSize=500",
      body: (() => {
        const b = { ...baseBody, pageSize: "500" } as Record<string, string>;
        delete b.pageNumber;
        b.pageNum = "1";
        return b;
      })(),
    },
    {
      name: "pageNumber=1, pageSize=500",
      body: { ...baseBody, pageSize: "500" },
    },
  ];

  console.log(
    "name".padEnd(34) + "events  curPage  lastPage  status  note".padEnd(40),
  );
  console.log("-".repeat(100));
  for (const t of tests) {
    try {
      const r = await probe(jsessionid, t.name, t.body);
      console.log(
        r.name.padEnd(34) +
          String(r.events).padEnd(8) +
          String(r.currentPage ?? "-").padEnd(9) +
          String(r.lastPage ?? "-").padEnd(10) +
          String(r.status).padEnd(8) +
          r.note,
      );
    } catch (err) {
      console.log(
        t.name.padEnd(34) +
          "ERR".padEnd(35) +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    // small delay to be polite to the WAF
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
