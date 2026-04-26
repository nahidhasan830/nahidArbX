/**
 * Test whether reading the MAIN-tier wallet zeroes out the
 * PROVIDER-tier balance (sister-platform behavior the user observed).
 *
 * Flow:
 *   1. Fresh session capture
 *   2. POST queryPlayerInfo (provider) — note betCredit
 *   3. GET  /account/wallet (main) — read withdrawable balance
 *   4. POST queryPlayerInfo (provider) again — check if betCredit is 0
 *   5. GET  /turnover/list (main)
 *   6. POST queryPlayerInfo (provider) third time — check again
 *
 * If step 4 returns 0 we have to skip the main-tier wallet read on the
 * dashboard while a sportsbook session is open.
 *
 * Run with:  npx tsx scripts/test-velki-wallet-conflict.ts
 */
import "dotenv/config";
import {
  captureSession,
  getSession,
  invalidateSession,
} from "../lib/betting/velki/session";
import { queryPlayerInfo } from "../lib/betting/velki/client";

const MAIN_HOST = "https://vk-sa.softtake.net";
const VELKI_ORIGIN = "https://velki.live";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

async function readMainWallet(token: string) {
  const res = await fetch(`${MAIN_HOST}/account/wallet`, {
    method: "GET",
    headers: {
      Authorization: `Token ${token}`,
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Origin: VELKI_ORIGIN,
      Referer: `${VELKI_ORIGIN}/`,
    },
  });
  return res.json();
}

async function readMainTurnover(token: string) {
  const res = await fetch(`${MAIN_HOST}/turnover/list`, {
    method: "GET",
    headers: {
      Authorization: `Token ${token}`,
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      Origin: VELKI_ORIGIN,
      Referer: `${VELKI_ORIGIN}/`,
    },
  });
  return res.json();
}

async function main() {
  console.log("[1] wiping cache + fresh capture");
  invalidateSession();
  const session = await captureSession();
  console.log("    jsessionid:", session.jsessionid);

  console.log("\n[2] provider queryPlayerInfo (initial)");
  const before = await queryPlayerInfo();
  console.log(
    "    betCredit:",
    before.betCredit,
    "exposure:",
    before.totalExposure,
  );

  console.log("\n[3] main /account/wallet");
  const wallet = await readMainWallet(session.token);
  console.log("    response:", JSON.stringify(wallet, null, 2));

  console.log("\n[4] provider queryPlayerInfo (after main wallet read)");
  // Don't catch — let session-expired errors bubble; that's diagnostic data.
  try {
    const afterWallet = await queryPlayerInfo();
    console.log(
      "    betCredit:",
      afterWallet.betCredit,
      "exposure:",
      afterWallet.totalExposure,
    );
    if (afterWallet.betCredit === 0 && before.betCredit !== 0) {
      console.log("    ✗ HYPOTHESIS CONFIRMED: provider balance zeroed");
    } else if (afterWallet.betCredit === before.betCredit) {
      console.log("    ✓ provider balance unaffected");
    }
  } catch (err) {
    console.log(
      "    ✗ provider call failed:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log("\n[5] main /turnover/list");
  // Re-read session in case a re-auth happened in step 4.
  const s2 = await getSession();
  const turnover = await readMainTurnover(s2.token);
  const tunoverCount = turnover?.data?.tunovers?.length ?? "?";
  console.log("    success:", turnover?.success, "tunovers:", tunoverCount);

  console.log("\n[6] provider queryPlayerInfo (after turnover read)");
  try {
    const afterTurnover = await queryPlayerInfo();
    console.log(
      "    betCredit:",
      afterTurnover.betCredit,
      "exposure:",
      afterTurnover.totalExposure,
    );
  } catch (err) {
    console.log(
      "    ✗ provider call failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
