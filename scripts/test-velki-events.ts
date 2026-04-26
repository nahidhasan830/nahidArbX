/**
 * Probe the Velki PROVIDER-tier events/markets/odds endpoints using
 * the captured JSESSIONID. Dumps raw responses so we can write proper
 * Zod schemas against actual data.
 *
 * Endpoints (all on bkqawscf.fwick7ets.xyz):
 *   1. POST /exchange/member/playerService/queryEventsWithMarket
 *   2. POST /exchange/member/playerService/queryFullMarkets
 *   3. POST /exchange/member/playerService/queryGeniusSportsEvent
 *
 * Run with:  npx tsx scripts/test-velki-events.ts
 */
import "dotenv/config";
import { getSession, invalidateSession } from "../lib/betting/velki/session";

const EVENTS_HOST = "https://bkqawscf.fwick7ets.xyz";
const PROVIDER_WEB_ORIGIN = "https://www.fwick7ets.xyz";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function browserHeaders(jsessionid: string): Record<string, string> {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: PROVIDER_WEB_ORIGIN,
    Referer: `${PROVIDER_WEB_ORIGIN}/`,
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

async function postForm(path: string, body: string, jsessionid: string) {
  const res = await fetch(`${EVENTS_HOST}${path};jsessionid=${jsessionid}`, {
    method: "POST",
    headers: browserHeaders(jsessionid),
    body,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* keep null */
  }
  return { status: res.status, raw: text, parsed };
}

function summarize(label: string, data: unknown) {
  console.log(`\n=== ${label} ===`);
  if (!data || typeof data !== "object") {
    console.log(data);
    return;
  }
  const obj = data as Record<string, unknown>;
  console.log("top-level keys:", Object.keys(obj));
  // Pretty-print first level so we see structure without 100KB dumps.
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      console.log(`  ${k}: Array(${v.length})`);
      if (v.length > 0)
        console.log(
          `    [0] sample:`,
          JSON.stringify(v[0], null, 2).slice(0, 800),
        );
    } else if (v && typeof v === "object") {
      console.log(
        `  ${k}: object — keys:`,
        Object.keys(v as Record<string, unknown>),
      );
    } else {
      console.log(`  ${k}:`, v);
    }
  }
}

async function main() {
  // Fresh session — single-session enforcement bumps any older one.
  invalidateSession();
  const session = await getSession();
  console.log("session:", session.jsessionid);

  // 1. queryEventsWithMarket — fixture list
  console.log("\n→ [1] queryEventsWithMarket");
  const events = await postForm(
    "/exchange/member/playerService/queryEventsWithMarket",
    "eventType=1&eventTs=-1&marketTs=-1&selectionTs=-1&viewType=openDateTime&competitionId=-1&pageNumber=1",
    session.jsessionid,
  );
  console.log("status:", events.status);
  summarize("queryEventsWithMarket response", events.parsed);

  // Pluck the first event with a market so we can probe further calls.
  const eventsObj = events.parsed as { events?: unknown[] } | null;
  const sampleEvent =
    Array.isArray(eventsObj?.events) && eventsObj!.events.length > 0
      ? (eventsObj!.events[0] as Record<string, unknown>)
      : null;
  if (!sampleEvent) {
    console.log("\n[!] no events in response — cannot probe further endpoints");
    return;
  }

  const eventId = String(sampleEvent.id ?? sampleEvent.eventId ?? "");
  // markets[] vs market vs nested — we don't know the shape yet, sniff.
  const marketsField =
    sampleEvent.markets ??
    sampleEvent.market ??
    sampleEvent.geniusSportsMarkets ??
    null;
  let marketId = "";
  if (Array.isArray(marketsField) && marketsField.length > 0) {
    const m0 = marketsField[0] as Record<string, unknown>;
    marketId = String(m0.marketId ?? m0.id ?? "");
    console.log(
      "\nfirst market sample:",
      JSON.stringify(m0, null, 2).slice(0, 600),
    );
  }
  console.log("\nprobing eventId=%s marketId=%s", eventId, marketId);

  if (!eventId) {
    console.log("[!] could not pluck eventId — stopping");
    return;
  }

  // 2. queryFullMarkets — full market structure for one event
  if (marketId) {
    console.log("\n→ [2] queryFullMarkets");
    const markets = await postForm(
      "/exchange/member/playerService/queryFullMarkets",
      `eventId=${eventId}&marketId=${marketId}&selectionTs=-1&isGetRunnerMetadata=false`,
      session.jsessionid,
    );
    console.log("status:", markets.status);
    summarize("queryFullMarkets response", markets.parsed);
  } else {
    console.log("\n[!] no marketId on first event — skipping queryFullMarkets");
  }

  // 3. queryGeniusSportsEvent — odds for a market
  console.log("\n→ [3] queryGeniusSportsEvent (catalog: version=0)");
  const oddsCatalog = await postForm(
    "/exchange/member/playerService/queryGeniusSportsEvent",
    `eventId=${eventId}&apiSiteType=4&version=0&marketIds=,&selectionTsList=,&isDynamicUpdate=0`,
    session.jsessionid,
  );
  console.log("status:", oddsCatalog.status);
  summarize("queryGeniusSportsEvent (catalog) response", oddsCatalog.parsed);
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
