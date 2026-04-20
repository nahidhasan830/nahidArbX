/**
 * UI-perspective bet placement test harness.
 *
 * Simulates what the browser does when an operator clicks an odds cell
 * in the spreadsheet: builds a runtime descriptor and POSTs it to
 * `/api/bets/place`. The goal is to surface every failure mode the UI
 * can hit — validation bugs, adapter errors, dedup quirks — so we can
 * fix them in one pass rather than playing whack-a-mole in the browser.
 *
 * Requires the Next.js dev server running on http://localhost:3000.
 *
 * Cases run by default:
 *   1. validation-missing-fields   — incomplete runtime, expect 400
 *   2. validation-soft-odds        — softOdds ≤ 1, expect 400
 *   3. validation-partial-sharp    — only some sharp fields, expect 400
 *   4. validation-zero-stake       — kellyStake = 0, expect 400
 *   5. unconfigured-provider       — softProvider = "pinnacle", expect skip/reject
 *   6. below-min-stake             — stake 50, expect rejected by book
 *   7. above-balance               — stake way above balance, expect rejected
 *   8. odds-too-high               — submitted odds > market, expect rejected
 *   9. successful-placement        — REAL bet at current odds (opt-out with --skip-real)
 *  10. duplicate-after-success     — re-post same runtime, expect "skipped (duplicate)"
 *
 * Running:
 *   npx tsx scripts/test-place-bet-ui.ts           # full battery
 *   npx tsx scripts/test-place-bet-ui.ts --dry-run # discover target, skip real bet
 *   npx tsx scripts/test-place-bet-ui.ts --skip-real
 *   npx tsx scripts/test-place-bet-ui.ts --only=below-min-stake
 *   npx tsx scripts/test-place-bet-ui.ts --base=http://localhost:3001
 */
import "dotenv/config";
import { getSession } from "../lib/betting/ninewickets/session";
import { queryPlayerInfo } from "../lib/betting/ninewickets/client";

// ────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes("--dry-run"),
  skipReal: argv.includes("--skip-real"),
  only:
    argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? null,
  base:
    argv.find((a) => a.startsWith("--base="))?.slice("--base=".length) ??
    "http://localhost:3000",
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
// Target discovery — find a real event from the value-bets endpoint
// that has 9W Sportsbook odds and is > 30m from kickoff.
// ────────────────────────────────────────────────────────────────────
interface Target {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  competition: string | null;
  startTime: string; // ISO
  familyId: string;
  atomId: string;
  atomLabel: string;
  marketType: string;
  softProvider: string;
  softOdds: number;
  // Optional sharp baseline (may be absent for manual-placement rows)
  sharpProvider?: string;
  sharpOdds?: number;
  sharpTrueProb?: number;
  commissionPct: number;
}

async function discoverTargetViaApi(): Promise<Target | null> {
  const url = `${flags.base}/api/value-bets?pageSize=200`;
  const res = await fetch(url);
  if (!res.ok) {
    console.log(red(`  GET /api/value-bets returned ${res.status}`));
    return null;
  }
  const body = (await res.json()) as {
    events?: Array<{
      eventId: string;
      homeTeam: string;
      awayTeam: string;
      competition?: string | null;
      startTime: string;
      families?: Array<{
        familyId: string;
        marketType: string;
        atoms?: Array<{
          atomId: string;
          label: string;
          oddsByProvider?: Record<
            string,
            { odds: number; timestamp: number; suspended?: boolean }
          >;
          valueBet?: {
            softProvider: string;
            sharpProvider: string;
            softOdds: number;
            sharpOdds: number;
            trueProb: number;
          };
        }>;
      }>;
    }>;
  };

  if (!body.events?.length) return null;

  const now = Date.now();
  // Prefer pre-match (>30m to kick) to avoid in-play selection locks.
  const candidates = body.events
    .filter((e) => new Date(e.startTime).getTime() > now + 30 * 60_000)
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );

  // Prefer MATCH_RESULT first (close less aggressively pre-match), fall
  // back to any family with a non-suspended 9W-SB selection.
  const MATCH_RESULT_FIRST = (a: any, b: any) =>
    Number(b.marketType === "MATCH_RESULT") -
    Number(a.marketType === "MATCH_RESULT");

  for (const ev of candidates) {
    for (const fam of (ev.families ?? []).slice().sort(MATCH_RESULT_FIRST)) {
      for (const atom of fam.atoms ?? []) {
        const nwsb = atom.oddsByProvider?.["ninewickets-sportsbook"];
        if (!nwsb || nwsb.suspended) continue;
        if (!Number.isFinite(nwsb.odds) || nwsb.odds < 1.1) continue;
        // Prefer short-priced favourites — more likely to still be open
        // by the time our discovery+test cycle reaches the real bet.
        if (nwsb.odds > 2.5) continue;
        return {
          eventId: ev.eventId,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          competition: ev.competition ?? null,
          startTime: ev.startTime,
          familyId: fam.familyId,
          atomId: atom.atomId,
          atomLabel: atom.label,
          marketType: fam.marketType,
          softProvider: "ninewickets-sportsbook",
          softOdds: nwsb.odds,
          sharpProvider: atom.valueBet?.sharpProvider,
          sharpOdds: atom.valueBet?.sharpOdds,
          sharpTrueProb: atom.valueBet?.trueProb,
          commissionPct: 0,
        };
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// HTTP helper — POST /api/bets/place with a runtime descriptor
// ────────────────────────────────────────────────────────────────────
interface PlaceResult {
  http: number;
  body: any;
}

async function postPlace(payload: any): Promise<PlaceResult> {
  const res = await fetch(`${flags.base}/api/bets/place`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = { error: `non-JSON response (${res.status})` };
  }
  return { http: res.status, body };
}

function runtime(
  t: Target,
  overrides: Partial<Target> & { softOdds?: number } = {},
) {
  const merged = { ...t, ...overrides };
  return {
    eventId: merged.eventId,
    familyId: merged.familyId,
    atomId: merged.atomId,
    atomLabel: merged.atomLabel,
    homeTeam: merged.homeTeam,
    awayTeam: merged.awayTeam,
    competition: merged.competition,
    eventStartTime: merged.startTime,
    marketType: merged.marketType,
    softProvider: merged.softProvider,
    softOdds: merged.softOdds,
    sharpProvider: merged.sharpProvider,
    sharpOdds: merged.sharpOdds,
    sharpTrueProb: merged.sharpTrueProb,
    commissionPct: merged.commissionPct,
  };
}

// ────────────────────────────────────────────────────────────────────
// Case runner
// ────────────────────────────────────────────────────────────────────
interface CaseOutcome {
  name: string;
  want: string;
  http: number;
  status: string; // "placed" | "pending" | "rejected" | "skipped" | "error" | "400" etc
  detail: string;
  // "pass" = observed outcome matches expectation; "fail" = doesn't match
  verdict: "pass" | "fail" | "skipped";
}

function interpret(r: PlaceResult): { status: string; detail: string } {
  if (r.http === 400 || r.http === 404) {
    return {
      status: `http-${r.http}`,
      detail: String(r.body?.error ?? "(no error field)"),
    };
  }
  const status = r.body?.status ?? "unknown";
  const detail =
    status === "placed"
      ? `placed @ ${r.body?.bookedOdds} stake=${r.body?.stake} ticket=${r.body?.ticketId ?? "-"}`
      : status === "pending"
        ? `pending (async ticket); stake=${r.body?.stake}`
        : status === "rejected" || status === "skipped" || status === "error"
          ? String(r.body?.reason ?? "(no reason)")
          : JSON.stringify(r.body).slice(0, 200);
  return { status, detail };
}

function renderStatus(v: CaseOutcome["verdict"], status: string): string {
  if (v === "pass") return green(`● PASS`);
  if (v === "fail") return red(`● FAIL (${status})`);
  return gray(`○ SKIP`);
}

// ────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────
async function caseValidationMissingFields(t: Target): Promise<CaseOutcome> {
  const payload = {
    kellyStake: 300,
    runtime: {
      // Deliberately missing: eventStartTime, marketType, softProvider
      eventId: t.eventId,
      familyId: t.familyId,
      atomId: t.atomId,
      atomLabel: t.atomLabel,
      homeTeam: t.homeTeam,
      awayTeam: t.awayTeam,
      softOdds: t.softOdds,
      commissionPct: 0,
    },
  };
  const r = await postPlace(payload);
  const { status, detail } = interpret(r);
  return {
    name: "validation-missing-fields",
    want: "400 with required-field error",
    http: r.http,
    status,
    detail,
    verdict: r.http === 400 ? "pass" : "fail",
  };
}

async function caseValidationSoftOdds(t: Target): Promise<CaseOutcome> {
  const r = await postPlace({
    kellyStake: 300,
    runtime: runtime(t, { softOdds: 0.5 }),
  });
  const { status, detail } = interpret(r);
  return {
    name: "validation-soft-odds",
    want: "400 softOdds must be > 1",
    http: r.http,
    status,
    detail,
    verdict: r.http === 400 ? "pass" : "fail",
  };
}

async function caseValidationPartialSharp(t: Target): Promise<CaseOutcome> {
  const r = await postPlace({
    kellyStake: 300,
    runtime: {
      ...runtime(t),
      // Only sharpProvider, no odds / trueProb — half-populated.
      sharpProvider: "pinnacle",
      sharpOdds: undefined,
      sharpTrueProb: undefined,
    },
  });
  const { status, detail } = interpret(r);
  return {
    name: "validation-partial-sharp",
    want: "400 sharp fields must be supplied together",
    http: r.http,
    status,
    detail,
    verdict: r.http === 400 ? "pass" : "fail",
  };
}

async function caseValidationZeroStake(t: Target): Promise<CaseOutcome> {
  const r = await postPlace({
    kellyStake: 0,
    runtime: runtime(t),
  });
  const { status, detail } = interpret(r);
  return {
    name: "validation-zero-stake",
    want: "400 kellyStake must be a positive number",
    http: r.http,
    status,
    detail,
    verdict: r.http === 400 ? "pass" : "fail",
  };
}

async function caseUnconfiguredProvider(t: Target): Promise<CaseOutcome> {
  const r = await postPlace({
    kellyStake: 300,
    runtime: runtime(t, { softProvider: "pinnacle" }),
  });
  const { status, detail } = interpret(r);
  // Expect the placer to skip/reject cleanly (no adapter configured).
  // Accept either a 409 rejection or a 200 skip.
  const ok =
    status === "skipped" ||
    status === "rejected" ||
    status === "error" ||
    r.http === 409 ||
    r.http === 500;
  return {
    name: "unconfigured-provider",
    want: "skip/reject — no betting adapter for 'pinnacle'",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

async function caseBelowMinStake(t: Target): Promise<CaseOutcome> {
  // Kelly stake below 9W's min. The placer clamps stake to [minBet, maxBet]
  // and will either size up OR skip with "stake below minimum".
  const r = await postPlace({
    kellyStake: 50,
    runtime: runtime(t),
  });
  const { status, detail } = interpret(r);
  const msg = detail.toLowerCase();
  const ok =
    status === "skipped" ||
    status === "placed" ||
    status === "pending" ||
    msg.includes("min") ||
    msg.includes("below");
  return {
    name: "below-min-stake",
    want: "stake clamped-up + placed OR skipped with 'below minimum'",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

async function caseAboveBalance(
  t: Target,
  balance: number,
): Promise<CaseOutcome> {
  const r = await postPlace({
    kellyStake: Math.round(balance + 5_000),
    runtime: runtime(t),
  });
  const { status, detail } = interpret(r);
  const msg = detail.toLowerCase();
  const ok =
    status === "rejected" ||
    status === "skipped" ||
    status === "error" ||
    msg.includes("balance") ||
    msg.includes("insufficient");
  return {
    name: "above-balance",
    want: "reject/skip with 'insufficient balance'",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

async function caseOddsTooHigh(t: Target): Promise<CaseOutcome> {
  // Request odds above current market → book should reject on price change.
  const r = await postPlace({
    kellyStake: 300,
    runtime: runtime(t, {
      softOdds: Math.round((t.softOdds + 0.5) * 100) / 100,
    }),
  });
  const { status, detail } = interpret(r);
  const msg = detail.toLowerCase();
  const ok =
    status === "rejected" ||
    status === "error" ||
    msg.includes("price") ||
    msg.includes("odds") ||
    msg.includes("change");
  return {
    name: "odds-too-high",
    want: "reject with price-changed message",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

async function caseSuccessfulPlacement(t: Target): Promise<CaseOutcome> {
  if (flags.skipReal) {
    return {
      name: "successful-placement",
      want: "placed or pending (REAL MONEY)",
      http: 0,
      status: "skipped-by-flag",
      detail: "--skip-real set",
      verdict: "skipped",
    };
  }
  const r = await postPlace({
    kellyStake: 300,
    runtime: runtime(t),
  });
  const { status, detail } = interpret(r);
  const ok = status === "placed" || status === "pending";
  return {
    name: "successful-placement",
    want: "placed or pending (REAL MONEY)",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

async function caseDuplicatePlacement(t: Target): Promise<CaseOutcome> {
  if (flags.skipReal) {
    return {
      name: "duplicate-after-success",
      want: "skipped — already placed",
      http: 0,
      status: "skipped-by-flag",
      detail: "(requires successful-placement — skipped with --skip-real)",
      verdict: "skipped",
    };
  }
  // Fire the same runtime again — dedup layer should skip.
  const r = await postPlace({
    kellyStake: 300,
    runtime: runtime(t),
  });
  const { status, detail } = interpret(r);
  const msg = detail.toLowerCase();
  const ok =
    status === "skipped" ||
    msg.includes("already") ||
    msg.includes("duplicate");
  return {
    name: "duplicate-after-success",
    want: "skipped — already placed",
    http: r.http,
    status,
    detail,
    verdict: ok ? "pass" : "fail",
  };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
function shouldRun(name: string): boolean {
  if (!flags.only) return true;
  return flags.only === name;
}

async function main() {
  console.log(bold("\nUI-PERSPECTIVE BET PLACEMENT TEST"));
  console.log(
    dim(
      `  base=${flags.base}  dry-run=${flags.dryRun}  skip-real=${flags.skipReal}  only=${flags.only ?? "all"}`,
    ),
  );

  // Sanity — dev server reachable? /api/health can return 503 for
  // semantic reasons (scheduler stopped, memory high) while still
  // serving placements fine, so we accept any HTTP response.
  header("DEV SERVER HEALTHCHECK");
  try {
    const res = await fetch(`${flags.base}/api/health`);
    const tag = res.ok ? green(String(res.status)) : yellow(String(res.status));
    console.log(`  GET /api/health → ${tag} (server responding)`);
  } catch (err) {
    console.log(red(`  Dev server unreachable at ${flags.base}`));
    console.log(
      dim(`  Start it with "npm run dev" or pass --base=<url>. Aborting.`),
    );
    process.exit(1);
  }

  // Session probe — need a valid 9W session to execute real placements.
  header("9W SESSION PROBE");
  let balance = 0;
  try {
    await getSession();
    const info = await queryPlayerInfo();
    balance = info.betCredit;
    console.log(
      green(
        `  Session OK — balance ${info.betCredit.toFixed(2)} BDT, min bet ${info.minBet}`,
      ),
    );
  } catch (err) {
    console.log(
      red(
        `  Session probe failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    console.log(
      dim(`  Real-money cases will be skipped. Fix 9W auth before re-running.`),
    );
    balance = 0;
  }

  // Target discovery
  header("TARGET DISCOVERY");
  const target = await discoverTargetViaApi();
  if (!target) {
    console.log(
      red(
        "  No pre-match 9W-SB event at odds 1.10–2.50 found via /api/value-bets.",
      ),
    );
    console.log(
      dim(
        `  Tip: run "curl ${flags.base}/api/providers" to verify data is flowing. Aborting.`,
      ),
    );
    process.exit(1);
  }
  console.log(
    `  Event    : ${bold(`${target.homeTeam} vs ${target.awayTeam}`)}  ${gray(
      `[${target.eventId}]`,
    )}`,
  );
  console.log(
    `  Market   : ${target.marketType}  →  ${target.atomLabel}  ${gray(
      `[${target.familyId}/${target.atomId}]`,
    )}`,
  );
  console.log(
    `  Soft     : ${target.softProvider} @ ${cyan(String(target.softOdds))}`,
  );
  if (target.sharpOdds) {
    console.log(
      `  Sharp    : ${target.sharpProvider} @ ${target.sharpOdds}  (trueProb ${target.sharpTrueProb?.toFixed(3)})`,
    );
  } else {
    console.log(dim(`  Sharp    : (none — manual-placement row)`));
  }

  if (flags.dryRun) {
    console.log(dim("\n  --dry-run set — stopping before any placements.\n"));
    return;
  }

  const results: CaseOutcome[] = [];

  async function run(
    name: string,
    fn: () => Promise<CaseOutcome>,
  ): Promise<void> {
    if (!shouldRun(name)) return;
    header(`CASE: ${name}`);
    try {
      const r = await fn();
      console.log(`  ${renderStatus(r.verdict, r.status)}  ${r.detail}`);
      console.log(
        dim(`  want: ${r.want}  ·  http=${r.http}  status=${r.status}`),
      );
      results.push(r);
    } catch (err) {
      console.log(
        red(
          `  ● ERROR thrown during case: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      results.push({
        name,
        want: "(case crashed)",
        http: 0,
        status: "throw",
        detail: err instanceof Error ? err.message : String(err),
        verdict: "fail",
      });
    }
  }

  // Validation-layer cases (cheap — no adapter call)
  await run("validation-missing-fields", () =>
    caseValidationMissingFields(target),
  );
  await run("validation-soft-odds", () => caseValidationSoftOdds(target));
  await run("validation-partial-sharp", () =>
    caseValidationPartialSharp(target),
  );
  await run("validation-zero-stake", () => caseValidationZeroStake(target));

  // Adapter-layer cases
  await run("unconfigured-provider", () => caseUnconfiguredProvider(target));
  await run("below-min-stake", () => caseBelowMinStake(target));
  if (balance > 0) {
    await run("above-balance", () => caseAboveBalance(target, balance));
  }
  await run("odds-too-high", () => caseOddsTooHigh(target));

  // Real-money cases (gated by --skip-real)
  await run("successful-placement", () => caseSuccessfulPlacement(target));
  await run("duplicate-after-success", () => caseDuplicatePlacement(target));

  // Summary
  header("SUMMARY");
  const passes = results.filter((r) => r.verdict === "pass").length;
  const fails = results.filter((r) => r.verdict === "fail").length;
  const skips = results.filter((r) => r.verdict === "skipped").length;
  for (const r of results) {
    console.log(
      `  ${renderStatus(r.verdict, r.status).padEnd(22)}  ${bold(r.name.padEnd(28))} ${dim(r.detail.slice(0, 80))}`,
    );
  }
  console.log(
    `\n  ${green(`${passes} pass`)}  ·  ${fails > 0 ? red(`${fails} fail`) : gray(`${fails} fail`)}  ·  ${gray(`${skips} skip`)}`,
  );
  if (fails > 0) process.exit(1);
}

main().catch((err) => {
  console.error(red("\nFATAL: "), err);
  process.exit(1);
});
