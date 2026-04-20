/**
 * End-to-end proof that a stale/expired 9wkts session can be recovered
 * automatically:
 *
 *   1. Launch Playwright, navigate to the 9wkts login page (Cloudflare-walled).
 *   2. Submit credentials. Read jsessionid + JWTs out of localStorage.
 *   3. Close the browser.
 *   4. From plain Node fetch, hit two exchange-host endpoints on the fresh
 *      session:
 *        - queryPlayerInfo (read)
 *        - geniusSportsBet  (write) — stake=100000 so it fails on balance;
 *                                     proves the full placement path works.
 *
 * Run with:  npx tsx scripts/test-9wkts-auto-relogin.ts
 */
import "dotenv/config";
import { chromium } from "playwright";

const LOGIN_URL = "https://9wktsbest.com/bd/en/login";
const EXCHANGE_HOST_READ = "https://gakvx.seofmi.live";
const EXCHANGE_HOST_WRITE = "https://gakqv.seofmi.live";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

interface CapturedSession {
  queryPass: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;
}

async function loginAndCapture(): Promise<CapturedSession> {
  const username = process.env.NINEWICKETS_USERNAME;
  const password = process.env.NINEWICKETS_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "NINEWICKETS_USERNAME / NINEWICKETS_PASSWORD missing in .env",
    );
  }

  const headless = process.env.TOKEN_HEADLESS !== "false";
  console.log(`→ Launching Playwright (headless=${headless})`);
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  try {
    console.log("→ Navigating to login page");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    console.log("→ Filling credentials");
    await page.fill('input[name="userId"]', username);
    await page.fill('input[name="password"]', password);

    console.log("→ Submitting form (Enter on password field)");
    // Wait for the login POST to complete so localStorage is populated.
    const [loginResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/bt/") && r.url().includes("/user/login"),
        { timeout: 30000 },
      ),
      page.press('input[name="password"]', "Enter"),
    ]);

    console.log(`  login response status=${loginResponse.status()}`);
    if (loginResponse.status() !== 200) {
      const body = await loginResponse.text();
      throw new Error(
        `login failed: ${loginResponse.status()} ${body.slice(0, 200)}`,
      );
    }

    // Login only populates JWT. The jsessionid (queryPass) is created when
    // the frontend first talks to the exchange API — navigate to the
    // exchange page to trigger that handshake.
    console.log("→ Navigating to /bd/en/EXSport to trigger exchange handshake");
    await page
      .goto("https://9wktsbest.com/bd/en/EXSport", {
        waitUntil: "domcontentloaded",
      })
      .catch(() => {
        /* hash-only nav may not load */
      });

    // Give the app a beat to write localStorage. Poll up to 30s; dump
    // whatever's there on timeout so we can diagnose unknown key names.
    const deadline = Date.now() + 30000;
    let captured: CapturedSession | null = null;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => {
        const keys: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) ?? "";
          keys[k] = localStorage.getItem(k) ?? "";
        }
        return keys;
      });
      if (snapshot.queryPass && snapshot.accessToken) {
        captured = {
          queryPass: snapshot.queryPass,
          accessToken: snapshot.accessToken,
          refreshToken: snapshot.refreshToken ?? "",
          accessTokenExp: Number(snapshot.accessTokenExp ?? 0),
        };
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!captured) {
      const dump = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) ?? "";
          const v = localStorage.getItem(k) ?? "";
          out[k] = v.length > 120 ? v.slice(0, 120) + "…" : v;
        }
        return out;
      });
      console.error(
        "localStorage snapshot on timeout:",
        JSON.stringify(dump, null, 2),
      );
      throw new Error("queryPass/accessToken not populated");
    }
    return captured;
  } finally {
    await browser.close();
  }
}

async function callQueryPlayerInfo(queryPass: string) {
  console.log("→ [Node] queryPlayerInfo");
  const url = `${EXCHANGE_HOST_READ}/exchange/member/playerService/queryPlayerInfo;jsessionid=${queryPass}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Authorization: queryPass,
      "User-Agent": UA,
    },
  });
  console.log(`  status=${res.status}`);
  const body = await res.text();
  console.log(`  body: ${body}`);
  return { status: res.status, body };
}

async function callPlaceBet(queryPass: string) {
  console.log(
    "→ [Node] geniusSportsBet (stake=100000 — expected to fail on balance)",
  );
  const url = `${EXCHANGE_HOST_WRITE}/exchange/member/playerService/geniusSportsBet;jsessionid=${queryPass}`;

  const payload = [
    {
      apiSiteType: 5,
      eventType: "1",
      eventId: "504116",
      marketId: "59560314",
      selectionId: 232511684,
      odds: 1.88,
      stake: 100000,
      betfairEventId: 35458539,
      handicap: 0,
    },
  ];

  const params = new URLSearchParams();
  params.set("apiSiteType", "5");
  params.set("geniusSportsBets", JSON.stringify(payload));
  params.set("voucherId", "");
  params.set("isOneClickBet", "0");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Authorization: queryPass,
      "User-Agent": UA,
    },
    body: params.toString(),
  });
  console.log(`  status=${res.status}`);
  const body = await res.text();
  console.log(`  body: ${body}`);
  return { status: res.status, body };
}

async function main() {
  const session = await loginAndCapture();
  console.log("\n✅ Captured fresh session:");
  console.log(`   queryPass:       ${session.queryPass}`);
  console.log(`   accessToken:     ${session.accessToken.slice(0, 40)}…`);
  console.log(`   refreshToken:    ${session.refreshToken.slice(0, 40)}…`);
  if (session.accessTokenExp) {
    const expAt = new Date(session.accessTokenExp * 1000);
    const minsFromNow = Math.round((expAt.getTime() - Date.now()) / 60000);
    console.log(
      `   accessTokenExp:  ${expAt.toISOString()} (+${minsFromNow} min)`,
    );
  }
  console.log();

  const info = await callQueryPlayerInfo(session.queryPass);
  if (info.status !== 200) throw new Error("queryPlayerInfo failed");

  console.log();
  const bet = await callPlaceBet(session.queryPass);

  console.log("\n=== Verdict ===");
  const betOk =
    bet.status === 200 &&
    (bet.body.includes("Insufficient balance") ||
      bet.body.includes('"status":"SUCCESS"'));
  if (info.status === 200 && betOk) {
    console.log("✅ Auto-recovery works end-to-end:");
    console.log("   - Playwright login captured a fresh session");
    console.log("   - Node fetch reached the exchange read endpoint");
    console.log("   - Node fetch reached the bet-placement endpoint");
    console.log(
      bet.body.includes("Insufficient balance")
        ? "   - Bet was rejected on balance (expected — account has ~0.5 BDT credit)"
        : "   - Bet was accepted (!)",
    );
  } else {
    console.log("❌ Something failed — see output above");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
