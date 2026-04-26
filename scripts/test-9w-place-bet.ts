/**
 * 9W Sportsbook bet-placement smoke test (mirrors test-velki-place-bet.ts).
 *
 * Goal: confirm whether 9W's response for a SUCCESS placement nests
 * the ticket id inside `unMatchTicket`/`txn` (same Genius Sports shape
 * we found for Velki) — in which case the 9W adapter has the same
 * "placed → misclassified as pending" bug.
 *
 * Run with:  npx tsx scripts/test-9w-place-bet.ts
 */
import "dotenv/config";
import { queryPlayerInfo } from "../lib/betting/ninewickets/client";
import { getSession } from "../lib/betting/ninewickets/session";
import { ninewicketsSportsbookAdapter } from "../lib/betting/ninewickets/adapter";

const STAKE = 120;
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const c = (s: string, k: keyof typeof C) => `${C[k]}${s}${C.reset}`;
const dim = (s: string) => c(s, "dim");
const bold = (s: string) => c(s, "bold");
const red = (s: string) => c(s, "red");
const green = (s: string) => c(s, "green");
const yellow = (s: string) => c(s, "yellow");
const cyan = (s: string) => c(s, "cyan");

function header(title: string) {
  console.log(`\n${bold(cyan("▶ " + title))} ${dim("─".repeat(60))}`);
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://9wktsbest.com",
  Referer: "https://9wktsbest.com/",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
} as const;

interface RawEvent {
  id: string;
  eventName: string;
  eventStartTime: number;
}

interface PostJsonResponse {
  events?: Array<{
    eventId?: number;
    eventName?: string;
    openDateTime?: number;
  }>;
  geniusSportsMarkets?: Array<RawMarket>;
  eventId?: number;
  version?: number;
}

interface RawMarket {
  id: string;
  marketName: string;
  apiSiteMarketType?: number;
  apiSiteStatus?: string;
  selectionTs?: number;
  min?: number;
  max?: number;
  geniusSportsSelection?: Array<RawSelection>;
}

interface RawSelection {
  id?: number;
  selectionName: string;
  odds: number;
  handicap?: number;
  isActive: boolean | number;
}

async function fetchSoccerEvents(queryPass: string): Promise<RawEvent[]> {
  const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryEvents;jsessionid=${queryPass}`;
  const out: RawEvent[] = [];
  for (const type of [1, 6]) {
    const body = new URLSearchParams({
      type: String(type),
      eventType: "1",
      competitionTs: "-1",
      eventTs: "-1",
      marketTs: "-1",
      selectionTs: "-1",
      collectEventIds: "",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: queryPass,
      },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`queryEvents type=${type} ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) {
      throw new Error(`queryEvents type=${type} returned HTML`);
    }
    const parsed = JSON.parse(text) as PostJsonResponse;
    for (const e of parsed.events ?? []) {
      if (e.eventId && e.eventName && e.openDateTime) {
        out.push({
          id: String(e.eventId),
          eventName: e.eventName,
          eventStartTime: e.openDateTime,
        });
      }
    }
  }
  return out;
}

async function fetchEventMarkets(
  queryPass: string,
  exchangeEventId: string,
): Promise<{
  markets: RawMarket[];
  geniusSportsEventId: number | null;
} | null> {
  const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent;jsessionid=${queryPass}`;

  async function post(
    params: Record<string, string>,
  ): Promise<PostJsonResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: queryPass,
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`POST queryGeniusSportsEvent → ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith("<")) throw new Error("expired (HTML)");
    return JSON.parse(text) as PostJsonResponse;
  }

  const catalog = await post({
    apiSiteType: "5",
    eventId: exchangeEventId,
    version: "0",
    marketIds: ",",
    selectionTsList: ",",
    isDynamicUpdate: "0",
  });
  const markets = catalog.geniusSportsMarkets ?? [];
  if (markets.length === 0) return null;

  const marketIds = markets.map((m) => m.id).join(",") + ",";
  const selectionTsList =
    markets.map((m) => m.selectionTs ?? -1).join(",") + ",";
  const version = catalog.version ?? 0;
  const withOdds = await post({
    apiSiteType: "5",
    eventId: exchangeEventId,
    version: String(version),
    marketIds,
    selectionTsList,
    isDynamicUpdate: "0",
  });
  const geniusSportsEventId =
    typeof withOdds.eventId === "number"
      ? withOdds.eventId
      : typeof catalog.eventId === "number"
        ? catalog.eventId
        : null;
  return {
    markets: withOdds.geniusSportsMarkets ?? markets,
    geniusSportsEventId,
  };
}

interface Target {
  exchangeEventId: string;
  geniusSportsEventId: number;
  eventName: string;
  marketId: string;
  marketName: string;
  selectionId: number;
  selectionName: string;
  odds: number;
  handicap: number;
}

async function discoverTarget(queryPass: string): Promise<Target | null> {
  const events = await fetchSoccerEvents(queryPass);
  const now = Date.now();
  const candidates = events
    .filter(
      (e) =>
        e.eventStartTime > now + 30 * 60_000 &&
        e.eventStartTime < now + 48 * 3600_000,
    )
    .sort((a, b) => a.eventStartTime - b.eventStartTime);

  console.log(
    dim(
      `  ${events.length} total events, ${candidates.length} pre-match in (30min, 48h)`,
    ),
  );

  let bestSeen: { target: Target; odds: number } | null = null;
  const MAX_PROBE = 25;

  for (const ev of candidates.slice(0, MAX_PROBE)) {
    const catalog = await fetchEventMarkets(queryPass, ev.id).catch(() => null);
    if (!catalog || catalog.geniusSportsEventId === null) continue;

    for (const m of catalog.markets) {
      if (m.apiSiteStatus && m.apiSiteStatus !== "OPEN") continue;
      const sels = m.geniusSportsSelection ?? [];
      if (sels.length < 2) continue;
      if (!sels.every((s) => Boolean(s.isActive))) continue;
      const name = String(m.marketName ?? "").toLowerCase();
      const isCore =
        name === "match odds" ||
        name === "match result" ||
        name === "1x2" ||
        name === "full time result" ||
        name.includes("full time result");
      if (!isCore) continue;

      for (const sel of sels) {
        const odds = Number(sel.odds);
        if (!Number.isFinite(odds) || odds < 1.05) continue;
        if (typeof sel.id !== "number") continue;
        const t: Target = {
          exchangeEventId: ev.id,
          geniusSportsEventId: catalog.geniusSportsEventId,
          eventName: ev.eventName,
          marketId: m.id,
          marketName: m.marketName,
          selectionId: sel.id,
          selectionName: sel.selectionName,
          odds,
          handicap: Number(sel.handicap ?? 0),
        };
        if (odds <= 1.5) return t;
        if (!bestSeen || odds < bestSeen.odds) bestSeen = { target: t, odds };
      }
    }
  }
  return bestSeen?.target ?? null;
}

async function main() {
  console.log(bold("\n9W SPORTSBOOK BET-PLACEMENT SMOKE TEST"));
  console.log(dim(`  stake = ${STAKE} BDT`));

  header("STEP 1 — session probe (queryPlayerInfo)");
  const info = await queryPlayerInfo();
  console.log(green("✓ session OK"));
  console.log(
    dim("  ") +
      JSON.stringify({
        betCredit: info.betCredit,
        creditAllocated: info.creditAllocated,
        totalExposure: info.totalExposure,
        minBet: info.minBet,
        accountSuspended: info.accountSuspended,
      }),
  );
  if (info.betCredit < STAKE) {
    console.log(
      red(`✗ balance ${info.betCredit} BDT < stake ${STAKE} BDT; abort`),
    );
    process.exit(3);
  }

  header("STEP 2 — target discovery");
  const session = await getSession();
  const target = await discoverTarget(session.queryPass);
  if (!target) {
    console.log(red("✗ no eligible event found"));
    process.exit(4);
  }
  console.log(green("✓ target found"));
  console.log(
    `  Event       : ${bold(target.eventName)}  ${dim("[ex=" + target.exchangeEventId + "  gs=" + target.geniusSportsEventId + "]")}`,
  );
  console.log(
    `  Market      : ${target.marketName}  ${dim("[" + target.marketId + "]")}`,
  );
  console.log(
    `  Selection   : ${bold(target.selectionName)}  @ ${cyan(String(target.odds))}  ${dim("[" + target.selectionId + "]")}`,
  );

  header(`STEP 3 — place ${STAKE} BDT @ ${target.odds}`);
  const providerRefs = {
    apiSiteType: 5,
    eventType: "1",
    eventId: String(target.geniusSportsEventId),
    marketId: target.marketId,
    selectionId: target.selectionId,
    handicap: target.handicap,
    betfairEventId: Number(target.exchangeEventId),
  };
  console.log(dim("  providerRefs: ") + JSON.stringify(providerRefs));

  const result = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs,
    stake: STAKE,
    odds: target.odds,
    currency: "BDT",
  });

  header("STEP 4 — adapter result");
  console.log(
    `  status      : ${
      result.status === "placed"
        ? green(result.status)
        : result.status === "pending"
          ? yellow(result.status)
          : red(result.status)
    }`,
  );
  if (result.status === "placed" || result.status === "pending") {
    console.log(`  ticketId    : ${result.ticketId ?? "(none)"}`);
    console.log(`  bookedOdds  : ${result.bookedOdds}`);
  }
  if (result.status === "rejected" || result.status === "error") {
    console.log(`  error       : ${red(result.error ?? "(none)")}`);
  }
  console.log(
    dim("  request     : ") + JSON.stringify(result.request, null, 2),
  );
  console.log(
    dim("  response    : ") + JSON.stringify(result.response, null, 2),
  );
}

main().catch((err) => {
  console.error(red("\nFATAL: "), err);
  process.exit(1);
});
