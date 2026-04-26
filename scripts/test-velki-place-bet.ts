/**
 * Velki Sportsbook bet-placement smoke test.
 *
 * Mirrors scripts/test-place-bet.ts but for the Velki adapter.
 *
 * Steps:
 *   1. Verify session by calling queryPlayerInfo (balance + min bet)
 *   2. Discover a real soccer event with a low-odds favorite (≤ 1.50)
 *      that's pre-match (kickoff > 30 min away, < 48h away)
 *   3. Submit a 120 BDT placement at the discovered odds via
 *      velkiSportsbookBettingAdapter.placeBet — same code path the
 *      manual /api/bets/place and the auto-placer use.
 *   4. Print the raw request, raw response, and the adapter's final
 *      verdict (placed / pending / rejected / error) so we can see
 *      exactly where it fails if it fails.
 *
 * Run with:  npx tsx /tmp/test-velki-place-bet.ts
 */
import "dotenv/config";
import {
  getSession,
  invalidateSession,
} from "/Users/nahidhasan/nahidArbX/lib/betting/velki/session";
import { queryPlayerInfo } from "/Users/nahidhasan/nahidArbX/lib/betting/velki/client";
import { velkiSportsbookBettingAdapter } from "/Users/nahidhasan/nahidArbX/lib/betting/velki/adapter";
import {
  fetchAllEvents,
  queryGeniusSportsCatalog,
  queryGeniusSportsOdds,
} from "/Users/nahidhasan/nahidArbX/lib/betting/velki/events-client";

const STAKE = 120;
const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const c = (s: string, k: keyof typeof COLOR) => `${COLOR[k]}${s}${COLOR.reset}`;
const dim = (s: string) => c(s, "dim");
const bold = (s: string) => c(s, "bold");
const red = (s: string) => c(s, "red");
const green = (s: string) => c(s, "green");
const yellow = (s: string) => c(s, "yellow");
const cyan = (s: string) => c(s, "cyan");

function header(title: string) {
  console.log(`\n${bold(cyan("▶ " + title))} ${dim("─".repeat(60))}`);
}

interface Target {
  exchangeEventId: string;
  geniusSportsEventId: number;
  eventName: string;
  competition: string;
  marketId: string;
  marketName: string;
  selectionId: number;
  selectionName: string;
  odds: number;
  handicap: number;
  marketMin?: number;
  marketMax?: number;
}

async function discoverTarget(): Promise<Target | null> {
  console.log(dim("→ fetchAllEvents() (soccer pages)"));
  const events = await fetchAllEvents(1);
  const now = Date.now();

  console.log(dim(`  ${events.length} total events on the wire`));

  const candidates: typeof events = [];
  for (const e of events) {
    // Pull marketDateTime from the embedded markets array — that's the
    // kickoff hint the events feed exposes; otherwise we can't pre-filter.
    const md = e.markets?.[0]?.marketDateTime;
    if (md && md > now + 30 * 60_000 && md < now + 48 * 3600_000) {
      candidates.push(e);
    }
  }
  candidates.sort(
    (a, b) =>
      (a.markets?.[0]?.marketDateTime ?? 0) -
      (b.markets?.[0]?.marketDateTime ?? 0),
  );
  console.log(
    dim(`  ${candidates.length} pre-match events in (30min, 48h) window`),
  );

  if (candidates.length === 0) return null;

  const MAX_PROBE = 25;
  let bestSeen: { target: Target; odds: number } | null = null;

  for (const ev of candidates.slice(0, MAX_PROBE)) {
    let catalog;
    try {
      catalog = await queryGeniusSportsCatalog(String(ev.id));
    } catch (err) {
      console.log(
        dim(
          `  skip ${ev.id} (${ev.name}): catalog ${err instanceof Error ? err.message : err}`,
        ),
      );
      continue;
    }
    const allMarkets = catalog.geniusSportsMarkets ?? [];
    if (allMarkets.length === 0) continue;
    if (typeof catalog.eventId !== "number") continue;

    let withOdds;
    try {
      withOdds = await queryGeniusSportsOdds(
        String(ev.id),
        catalog.version ?? 0,
        allMarkets.map((m) => m.id),
        allMarkets.map((m) => m.selectionTs ?? -1),
      );
    } catch {
      continue;
    }
    const markets = withOdds.geniusSportsMarkets ?? allMarkets;

    for (const m of markets) {
      if (m.apiSiteStatus && m.apiSiteStatus !== "OPEN") continue;
      const sels = m.geniusSportsSelection ?? [];
      // Need a fully active market — partial closes often reject placements
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
          exchangeEventId: String(ev.id),
          geniusSportsEventId: catalog.eventId,
          eventName: ev.name,
          competition: ev.competitionName ?? "",
          marketId: m.id,
          marketName: m.marketName,
          selectionId: sel.id,
          selectionName: sel.selectionName,
          odds,
          handicap: Number(sel.handicap ?? 0),
          marketMin: m.min,
          marketMax: m.max,
        };
        // Prefer a strong favorite (cheap to lose money on).
        if (odds <= 1.5) return t;
        if (!bestSeen || odds < bestSeen.odds) bestSeen = { target: t, odds };
      }
    }
  }
  return bestSeen?.target ?? null;
}

async function main() {
  console.log(bold("\nVELKI SPORTSBOOK BET-PLACEMENT SMOKE TEST"));
  console.log(dim(`  stake = ${STAKE} BDT`));

  // === 1. Session probe =================================================
  header("STEP 1 — session probe (queryPlayerInfo)");
  let info;
  try {
    info = await queryPlayerInfo();
  } catch (err) {
    console.log(
      red(`✗ session unhealthy: ${err instanceof Error ? err.message : err}`),
    );
    console.log(
      dim(
        "  → trying invalidateSession() + getSession() to force a fresh capture",
      ),
    );
    invalidateSession();
    try {
      const fresh = await getSession(true);
      console.log(
        green("✓ recaptured: ") +
          JSON.stringify({
            jsessionid: fresh.jsessionid,
            capturedAt: fresh.capturedAt,
          }),
      );
      info = await queryPlayerInfo();
    } catch (err2) {
      console.log(
        red(
          `✗ recapture also failed: ${err2 instanceof Error ? err2.message : err2}`,
        ),
      );
      process.exit(1);
    }
  }
  console.log(green("✓ session OK"));
  console.log(
    dim("  ") +
      JSON.stringify({
        betCredit: info.betCredit,
        creditAllocated: info.creditAllocated,
        totalExposure: info.totalExposure,
        minBet: info.minBet,
        accountSuspended: info.accountSuspended,
        accountSysSuspended: info.accountSysSuspended,
      }),
  );

  if (info.accountSuspended || info.accountSysSuspended) {
    console.log(red("✗ account is suspended by the book; abort"));
    process.exit(2);
  }
  if (info.betCredit < STAKE) {
    console.log(
      red(`✗ balance ${info.betCredit} BDT < stake ${STAKE} BDT; abort`),
    );
    process.exit(3);
  }

  // === 2. Target discovery ==============================================
  header("STEP 2 — target discovery");
  const target = await discoverTarget();
  if (!target) {
    console.log(red("✗ no eligible event found — try again later"));
    process.exit(4);
  }
  console.log(green("✓ target found"));
  console.log(`  Competition : ${target.competition}`);
  console.log(
    `  Event       : ${bold(target.eventName)}  ${dim("[ex=" + target.exchangeEventId + "  gs=" + target.geniusSportsEventId + "]")}`,
  );
  console.log(
    `  Market      : ${target.marketName}  ${dim("[" + target.marketId + "]")}`,
  );
  console.log(
    `  Selection   : ${bold(target.selectionName)}  @ ${cyan(String(target.odds))}  ${dim("[" + target.selectionId + "]")}`,
  );
  console.log(
    `  Limits      : min=${target.marketMin ?? "?"}  max=${target.marketMax ?? "?"}`,
  );

  // === 3. Place the test bet ============================================
  header(`STEP 3 — place ${STAKE} BDT @ ${target.odds}`);
  const providerRefs = {
    apiSiteType: 4,
    eventType: "1",
    eventId: String(target.geniusSportsEventId),
    marketId: target.marketId,
    selectionId: target.selectionId,
    handicap: target.handicap,
    betfairEventId: Number(target.exchangeEventId),
  };
  console.log(dim("  providerRefs: ") + JSON.stringify(providerRefs));

  const result = await velkiSportsbookBettingAdapter.placeBet({
    providerRefs,
    stake: STAKE,
    odds: target.odds,
    currency: "BDT",
  });

  header("STEP 4 — adapter result");
  console.log(
    `  status      : ${result.status === "placed" ? green(result.status) : result.status === "pending" ? yellow(result.status) : red(result.status)}`,
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
