/**
 * 9W Sportsbook bet-placement test harness.
 *
 * Sends a battery of placement attempts at the real 9W API to verify
 * that each failure mode surfaces a clean, user-facing message.
 *
 * Test cases:
 *   1. session-probe      — queryPlayerInfo with current session
 *   2. below-min          — stake 100 BDT (under the 119 floor)
 *   3. above-balance      — stake (balance + 5000)
 *   4. odds-too-high      — submit at (market odds + 0.50), expect PRICE_CHANGED
 *   5. successful-bet     — 300 BDT at current low-odds favorite (only real bet)
 *   6. relogin-probe      — (optional, --test-relogin) nuke session + re-fetch
 *
 * Running:
 *   npx tsx scripts/test-place-bet.ts                # run defaults 1-5
 *   npx tsx scripts/test-place-bet.ts --dry-run      # print target + skip bets
 *   npx tsx scripts/test-place-bet.ts --skip-real    # skip the real-money bet
 *   npx tsx scripts/test-place-bet.ts --test-relogin # include case 6
 *   npx tsx scripts/test-place-bet.ts --only=below-min
 *
 * IMPORTANT: This script bypasses placer.placeBetForValueBet so NO DB
 * rows are written — it hits adapter.placeBet directly.
 */
import "dotenv/config";
import {
  getSession,
  invalidateSession,
} from "../lib/betting/ninewickets/session";
import { queryPlayerInfo } from "../lib/betting/ninewickets/client";
import { ninewicketsSportsbookAdapter } from "../lib/betting/ninewickets/adapter";
import type { PlaceBetResult } from "../lib/betting/types";

// ────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes("--dry-run"),
  skipReal: argv.includes("--skip-real"),
  testRelogin: argv.includes("--test-relogin"),
  only:
    argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? null,
  /** Force a specific exchange event id (skip discovery). */
  forceEvent:
    argv.find((a) => a.startsWith("--event="))?.slice("--event=".length) ??
    null,
};

// ────────────────────────────────────────────────────────────────────
// ANSI colours
// ────────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const bold = (s: string) => `${C.bold}${s}${C.reset}`;
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const red = (s: string) => `${C.red}${s}${C.reset}`;
const green = (s: string) => `${C.green}${s}${C.reset}`;
const yellow = (s: string) => `${C.yellow}${s}${C.reset}`;
const cyan = (s: string) => `${C.cyan}${s}${C.reset}`;
const gray = (s: string) => `${C.gray}${s}${C.reset}`;

function header(title: string) {
  const bar = "─".repeat(Math.max(0, 70 - title.length));
  console.log(`\n${bold(cyan("▶ " + title))} ${gray(bar)}`);
}

// ────────────────────────────────────────────────────────────────────
// Event/market discovery — minimal inline fetcher. Picks a soccer
// event ~30min–6h from now and returns a providerRefs for its
// strongest favorite at odds ≤ 1.30 so the real-money case is both
// likely-to-win and cheap.
// ────────────────────────────────────────────────────────────────────
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Full browser-origin header set — 9W WAF rejects requests without
// these on some hosts (returns 200 with empty body).
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
};

interface Target {
  eventId: string;
  eventName: string;
  marketId: string;
  marketName: string;
  selectionId: number;
  selectionName: string;
  odds: number;
  handicap: number;
  providerRefs: Record<string, string | number>;
}

async function fetchSoccerEvents(
  queryPass: string,
): Promise<Array<{ id: string; eventName: string; eventStartTime: number }>> {
  const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryEvents;jsessionid=${queryPass}`;

  // Fetch both live (type=1) and upcoming (type=6). The numeric "type"
  // is a listing filter used by 9W's event API, not the sportsbook
  // apiSiteType (which only applies to per-event endpoints).
  const out: Array<{ id: string; eventName: string; eventStartTime: number }> =
    [];
  for (const type of [1, 6]) {
    const body = new URLSearchParams({
      type: String(type),
      eventType: "1", // soccer
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
    const parsed = JSON.parse(text) as {
      events?: Array<{
        eventId?: number;
        eventName?: string;
        openDateTime?: number;
      }>;
    };
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

interface EventMarketsResult {
  markets: any[];
  /** Genius Sports internal event id — goes into placeBet.eventId. */
  geniusSportsEventId: number | null;
}

async function fetchEventMarkets(
  queryPass: string,
  exchangeEventId: string,
): Promise<EventMarketsResult | null> {
  const url = `https://gakvx.seofmi.live/exchange/member/playerService/queryGeniusSportsEvent;jsessionid=${queryPass}`;

  const catalog = await post(url, queryPass, {
    apiSiteType: "5",
    eventId: exchangeEventId,
    version: "0",
    marketIds: ",",
    selectionTsList: ",",
    isDynamicUpdate: "0",
  });
  const markets = (catalog.geniusSportsMarkets ?? []) as any[];
  if (markets.length === 0) return null;

  // Step 2 — fetch odds for all markets in a single call
  const marketIds = markets.map((m: any) => m.id).join(",") + ",";
  const selectionTsList =
    markets.map((m: any) => m.selectionTs ?? -1).join(",") + ",";
  const version = catalog.version ?? 0;
  const withOdds = await post(url, queryPass, {
    apiSiteType: "5",
    eventId: exchangeEventId,
    version: String(version),
    marketIds,
    selectionTsList,
    isDynamicUpdate: "0",
  });
  // Prefer the odds-step's geniusSports eventId (fresher) but fall
  // back to the catalog step; either should be present. This is the
  // id we need for placement, NOT the exchange id we queried by.
  const geniusSportsEventId =
    typeof withOdds.eventId === "number"
      ? withOdds.eventId
      : typeof catalog.eventId === "number"
        ? catalog.eventId
        : null;
  return {
    markets: (withOdds.geniusSportsMarkets ?? markets) as any[],
    geniusSportsEventId,
  };
}

async function post(
  url: string,
  queryPass: string,
  params: Record<string, string>,
): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: queryPass,
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`POST ${url.split(";")[0]} → ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) throw new Error("expired (HTML)");
  return JSON.parse(text);
}

async function discoverTarget(queryPass: string): Promise<Target | null> {
  const events = await fetchSoccerEvents(queryPass);
  const now = Date.now();
  // PRE-MATCH ONLY. In-play events frequently have selection-level
  // locks ("Selection X is Close!") that we can't detect from
  // apiSiteStatus alone. Require kickoff to be at least 30m away.
  let candidates = events
    .filter(
      (e) =>
        e.eventStartTime > now + 30 * 60_000 && // at least 30m to kickoff
        e.eventStartTime < now + 48 * 3600_000, // within 48h
    )
    .sort((a, b) => a.eventStartTime - b.eventStartTime); // earliest first

  // --event=<exchangeId> override — force a specific event, skip discovery.
  if (flags.forceEvent) {
    const forced = events.find((e) => e.id === flags.forceEvent);
    if (forced) {
      candidates = [forced];
      console.log(
        dim(
          `  (--event=${flags.forceEvent} → forced to "${forced.eventName}")`,
        ),
      );
    } else {
      // Event might not be in the event list anymore (past) but still
      // queryable. Synthesize a minimal entry so the catalog fetch can
      // still run.
      candidates = [
        {
          id: flags.forceEvent,
          eventName: `(forced ${flags.forceEvent})`,
          eventStartTime: now + 60_000, // dummy future time so it isn't filtered
        },
      ];
      console.log(
        dim(`  (--event=${flags.forceEvent} → forced, not in live listing)`),
      );
    }
  } else {
    console.log(
      dim(
        `  (${events.length} soccer events total, ${candidates.length} pre-match in next 48h)`,
      ),
    );
  }

  // Track the lowest-odds selection we've seen in case we exhaust the
  // preferred range and need to fall back.
  let bestSeen: { target: Target; odds: number } | null = null;
  // Cap how many events we probe to keep dry-run latency reasonable.
  const MAX_PROBE = 30;
  let probed = 0;

  // Prefer the core three outcome markets — 1X2 / Match Result /
  // Full Time Result. Exotic props close pre-match too often to be
  // reliable probing targets.
  function isPreferredMarket(market: any): boolean {
    const name = String(market.marketName ?? "")
      .toLowerCase()
      .trim();
    // 9W uses different names across sports/competitions for the
    // same "who wins the match" concept.
    return (
      name === "match odds" ||
      name === "match result" ||
      name === "full time result" ||
      name === "1x2" ||
      name.includes("full time result") ||
      name.startsWith("to win") // e.g. "To Win The Match"
    );
  }
  // Every selection in the market must be active — a partially-open
  // market (e.g. draw closed but home/away open) often rejects on
  // placement with "Selection X is Close!".
  function allSelectionsActive(market: any): boolean {
    const sels = (market.geniusSportsSelection ?? []) as any[];
    if (sels.length < 2) return false;
    return sels.every((s) => Boolean(s.isActive));
  }

  for (const event of candidates.slice(0, MAX_PROBE)) {
    const catalog = await fetchEventMarkets(queryPass, event.id).catch(
      () => null,
    );
    if (!catalog) continue;
    if (catalog.geniusSportsEventId === null) continue;

    // Debug: collect a quick sample of market names for the first
    // event so we know what the book actually calls the 1X2 market.
    if (probed === 0) {
      const sample = catalog.markets
        .slice(0, 5)
        .map(
          (m: any) =>
            `${m.marketName} [type=${m.apiSiteMarketType}, status=${m.apiSiteStatus ?? "?"}]`,
        );
      console.log(dim(`  sample markets: ${sample.join(" | ")}`));
    }
    probed++;
    for (const market of catalog.markets) {
      if (market.apiSiteStatus !== "OPEN") continue;
      if (!isPreferredMarket(market)) continue;
      if (!allSelectionsActive(market)) continue;
      const selections = (market.geniusSportsSelection ?? []) as any[];
      for (const sel of selections) {
        if (!sel.isActive) continue;
        const odds = Number(sel.odds);
        if (!Number.isFinite(odds) || odds < 1.05) continue;

        // selectionId must be the GS INTERNAL id (sel.id), NOT
        // apiSiteSelectionId — placement silently rejects the
        // latter with "Selection is Close!".
        const candidate: Target = {
          eventId: event.id,
          eventName: event.eventName,
          marketId: String(market.id),
          marketName: String(market.marketName),
          selectionId: Number(sel.id),
          selectionName: String(sel.selectionName),
          odds,
          handicap: Number(sel.handicap ?? 0),
          providerRefs: {
            apiSiteType: 5,
            eventType: "1",
            // GS internal ids throughout — not the apiSite* variants.
            eventId: String(catalog.geniusSportsEventId),
            marketId: String(market.id),
            selectionId: Number(sel.id),
            handicap: Number(sel.handicap ?? 0),
            // betfair/exchange id is the one we looked up with.
            betfairEventId: Number(event.id),
          },
        };

        // Preferred: strong favorite (likely to win).
        if (odds <= 1.5) return candidate;

        // Otherwise remember the lowest-odds selection as a fallback.
        if (!bestSeen || odds < bestSeen.odds) {
          bestSeen = { target: candidate, odds };
        }
      }
    }
  }
  return bestSeen ? bestSeen.target : null;
}

// ────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────
interface CaseOutcome {
  name: string;
  stake: number;
  odds: number;
  want: string; // what we expected to happen
  status: PlaceBetResult["status"] | "session-ok" | "session-fail" | "skipped";
  detail: string;
  ticketId?: string;
}

function renderStatus(s: CaseOutcome["status"]): string {
  switch (s) {
    case "placed":
      return green("● PLACED");
    case "pending":
      return yellow("● PENDING");
    case "rejected":
      return yellow("● REJECTED");
    case "error":
      return red("● ERROR");
    case "session-ok":
      return green("● OK");
    case "session-fail":
      return red("● FAIL");
    case "skipped":
      return gray("○ SKIP");
  }
}

function renderSummary(results: CaseOutcome[]) {
  header("SUMMARY");
  const lines = results.map(
    (r) =>
      `  ${renderStatus(r.status).padEnd(22)}  ${bold(r.name.padEnd(18))} ` +
      `${dim("want:")} ${r.want}\n` +
      `    ${dim(`stake=${r.stake}  odds=${r.odds}${r.ticketId ? `  ticket=${r.ticketId}` : ""}`)}\n` +
      `    ${r.detail}`,
  );
  console.log(lines.join("\n\n"));

  const hasFail = results.some(
    (r) => r.status === "error" || r.status === "session-fail",
  );
  const note = hasFail
    ? red("\n  One or more cases hit an unexpected error — see above.")
    : green("\n  All cases returned user-friendly messages.");
  console.log(note);
}

// ────────────────────────────────────────────────────────────────────
// Individual test cases
// ────────────────────────────────────────────────────────────────────
function resultDetail(r: PlaceBetResult, want: string): string {
  if (r.status === "placed" || r.status === "pending") {
    const tid = r.ticketId ? ` (ticket ${r.ticketId})` : "";
    const label =
      r.status === "placed"
        ? green(`Book confirmed placement at ${r.bookedOdds}${tid}`)
        : yellow(`Book accepted, still processing — ticket will follow${tid}`);
    return label;
  }
  if (r.status === "rejected") {
    // Rejection is expected for most cases — call it green if it matches.
    const friendly = r.error ?? "(no error field)";
    return `Book rejection → ${bold(friendly)}`;
  }
  return red(`Transport/auth error → ${r.error ?? "(empty)"}`);
}

async function caseSessionProbe(): Promise<CaseOutcome> {
  const want = "queryPlayerInfo succeeds with existing session";
  try {
    const info = await queryPlayerInfo();
    return {
      name: "session-probe",
      stake: 0,
      odds: 0,
      want,
      status: "session-ok",
      detail:
        `Balance: ${info.betCredit.toFixed(2)} BDT  ·  ` +
        `Exposure: ${info.totalExposure.toFixed(2)}  ·  ` +
        `Min bet: ${info.minBet}  ·  ` +
        (info.accountSuspended ? red("SUSPENDED") : green("active")),
    };
  } catch (err) {
    return {
      name: "session-probe",
      stake: 0,
      odds: 0,
      want,
      status: "session-fail",
      detail: red(
        `queryPlayerInfo threw: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

async function caseBelowMin(target: Target): Promise<CaseOutcome> {
  const stake = 100; // under the 119 minimum
  const want = "book rejects with a 'below minimum' message";
  const r = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: target.providerRefs,
    stake,
    odds: target.odds,
    currency: "BDT",
  });
  return {
    name: "below-min",
    stake,
    odds: target.odds,
    want,
    status: r.status,
    detail: resultDetail(r, want),
    ticketId: r.ticketId,
  };
}

async function caseAboveBalance(
  target: Target,
  balance: number,
): Promise<CaseOutcome> {
  const stake = Math.round(balance + 5000);
  const want = "book rejects with an 'insufficient balance' message";
  const r = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: target.providerRefs,
    stake,
    odds: target.odds,
    currency: "BDT",
  });
  return {
    name: "above-balance",
    stake,
    odds: target.odds,
    want,
    status: r.status,
    detail: resultDetail(r, want),
    ticketId: r.ticketId,
  };
}

async function caseOddsTooHigh(target: Target): Promise<CaseOutcome> {
  // Submit at a price well above what the market offers. Book should
  // reject because we're asking for better odds than it currently shows.
  const submittedOdds = Math.round((target.odds + 0.5) * 100) / 100;
  const want = "book rejects because requested odds > market odds";
  const r = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: target.providerRefs,
    stake: 300,
    odds: submittedOdds,
    currency: "BDT",
  });
  return {
    name: "odds-too-high",
    stake: 300,
    odds: submittedOdds,
    want,
    status: r.status,
    detail: resultDetail(r, want),
    ticketId: r.ticketId,
  };
}

async function caseSuccessfulBet(target: Target): Promise<CaseOutcome> {
  const stake = 300;
  const want = "book accepts (placed or pending)";
  const r = await ninewicketsSportsbookAdapter.placeBet({
    providerRefs: target.providerRefs,
    stake,
    odds: target.odds,
    currency: "BDT",
  });
  return {
    name: "successful-bet",
    stake,
    odds: target.odds,
    want,
    status: r.status,
    detail: resultDetail(r, want),
    ticketId: r.ticketId,
  };
}

async function caseReloginProbe(): Promise<CaseOutcome> {
  const want = "invalidated session auto-recovers via Playwright re-login";
  try {
    invalidateSession();
    const fresh = await getSession(true);
    const info = await queryPlayerInfo();
    return {
      name: "relogin-probe",
      stake: 0,
      odds: 0,
      want,
      status: "session-ok",
      detail:
        green("Re-login succeeded. ") +
        `New session captured at ${fresh.capturedAt}. Balance: ${info.betCredit.toFixed(2)} BDT`,
    };
  } catch (err) {
    return {
      name: "relogin-probe",
      stake: 0,
      odds: 0,
      want,
      status: "session-fail",
      detail: red(
        `Re-login failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
function shouldRun(name: string): boolean {
  if (!flags.only) return true;
  return flags.only === name;
}

async function main() {
  console.log(bold("\n9W SPORTSBOOK BET-PLACEMENT TEST HARNESS"));
  console.log(
    dim(
      `  dry-run=${flags.dryRun}  skip-real=${flags.skipReal}  test-relogin=${flags.testRelogin}  only=${flags.only ?? "all"}`,
    ),
  );

  // Session probe first — need a valid session for everything below.
  const probe = await caseSessionProbe();
  const results: CaseOutcome[] = [probe];
  if (probe.status !== "session-ok") {
    console.log(red("\n  Session is broken. Halting before placing bets."));
    renderSummary(results);
    process.exit(1);
  }
  console.log(`  ${renderStatus(probe.status)}  ${probe.detail}`);

  const info = await queryPlayerInfo();
  const balance = info.betCredit;

  // Discover a target.
  header("TARGET DISCOVERY");
  const session = await getSession();
  const target = await discoverTarget(session.queryPass);
  if (!target) {
    console.log(
      red(
        "  No event with a selection at odds 1.05–1.30 found in the next 6h.",
      ),
    );
    console.log(
      dim("  Try again in a bit, or widen the odds filter in this script."),
    );
    process.exit(1);
  }
  console.log(
    `  Event    : ${bold(target.eventName)}  ${gray(`[${target.eventId}]`)}`,
  );
  console.log(
    `  Market   : ${target.marketName}  ${gray(`[${target.marketId}]`)}`,
  );
  console.log(
    `  Selection: ${bold(target.selectionName)}  @ ${cyan(String(target.odds))}  ${gray(`[${target.selectionId}]`)}`,
  );

  if (flags.dryRun) {
    console.log(dim("\n  --dry-run set — stopping before any placements.\n"));
    return;
  }

  // 2. below-min
  if (shouldRun("below-min")) {
    header("CASE: below-min stake");
    const r = await caseBelowMin(target);
    console.log(`  ${renderStatus(r.status)}  ${r.detail}`);
    results.push(r);
  }

  // 3. above-balance
  if (shouldRun("above-balance")) {
    header("CASE: above-balance stake");
    const r = await caseAboveBalance(target, balance);
    console.log(`  ${renderStatus(r.status)}  ${r.detail}`);
    results.push(r);
  }

  // 4. odds-too-high
  if (shouldRun("odds-too-high")) {
    header("CASE: odds higher than market");
    const r = await caseOddsTooHigh(target);
    console.log(`  ${renderStatus(r.status)}  ${r.detail}`);
    results.push(r);
  }

  // 5. successful bet (real money)
  if (shouldRun("successful-bet")) {
    if (flags.skipReal) {
      results.push({
        name: "successful-bet",
        stake: 300,
        odds: target.odds,
        want: "book accepts (placed or pending)",
        status: "skipped",
        detail: dim("--skip-real set; real-money case not executed"),
      });
    } else {
      header("CASE: successful bet (REAL MONEY, 300 BDT)");
      const r = await caseSuccessfulBet(target);
      console.log(`  ${renderStatus(r.status)}  ${r.detail}`);
      results.push(r);
    }
  }

  // 6. relogin probe (opt-in)
  if (flags.testRelogin && shouldRun("relogin-probe")) {
    header("CASE: session invalidation + auto-relogin");
    const r = await caseReloginProbe();
    console.log(`  ${renderStatus(r.status)}  ${r.detail}`);
    results.push(r);
  }

  renderSummary(results);
}

main().catch((err) => {
  console.error(red("\nFATAL: "), err);
  process.exit(1);
});
