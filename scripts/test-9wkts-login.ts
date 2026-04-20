/**
 * Test 9wkts login → queryPlayerInfo round-trip.
 *
 * Run with:  npx tsx scripts/test-9wkts-login.ts
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

const LOGIN_URL = "https://9wktsbest.com/api/bt/v2_1/user/login";
const PLAYER_INFO_URL_BASE =
  "https://gakvx.seofmi.live/exchange/member/playerService/queryPlayerInfo";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function hex32() {
  return randomBytes(16).toString("hex");
}

async function main() {
  const userId = process.env.NINEWICKETS_USERNAME;
  const password = process.env.NINEWICKETS_PASSWORD;
  if (!userId || !password) {
    throw new Error(
      "NINEWICKETS_USERNAME / NINEWICKETS_PASSWORD not set in .env",
    );
  }

  console.log("→ POST login");
  const loginBody = {
    languageTypeId: 1,
    currencyTypeId: 8,
    userId,
    password,
    isBioLogin: false,
    loginTypeId: 0,
    fingerprint2: hex32(),
    fingerprint4: hex32(),
    browserHash: hex32(),
    deviceHash: hex32(),
  };

  const loginRes = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      Origin: "https://9wktsbest.com",
      Referer: "https://9wktsbest.com/bd/en/login",
      "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(loginBody),
  });

  console.log(`  status: ${loginRes.status}`);
  const loginJsonText = await loginRes.text();
  console.log(
    `  body preview: ${loginJsonText.slice(0, 500)}${loginJsonText.length > 500 ? "…" : ""}`,
  );

  let loginJson: any;
  try {
    loginJson = JSON.parse(loginJsonText);
  } catch {
    throw new Error("login response is not JSON");
  }

  // Collect candidate fields that might hold the jsessionid
  const candidateKeys = [
    "queryPass",
    "jsessionid",
    "sessionId",
    "token",
    "accessToken",
    "refreshToken",
  ];
  const top = loginJson?.data ?? loginJson;
  console.log("  top-level keys:", Object.keys(top ?? {}));
  for (const k of candidateKeys) {
    if (top?.[k]) {
      const v = String(top[k]);
      console.log(`    ${k} = ${v.length > 80 ? v.slice(0, 80) + "…" : v}`);
    }
  }

  const queryPass: string | undefined = top?.queryPass;
  const accessToken: string | undefined = top?.accessToken;

  if (!queryPass) {
    throw new Error("login response did not include a queryPass (jsessionid)");
  }

  console.log("\n→ POST queryPlayerInfo");
  const playerInfoUrl = `${PLAYER_INFO_URL_BASE};jsessionid=${queryPass}`;
  const piRes = await fetch(playerInfoUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json, text/plain, */*",
      Authorization: queryPass,
      "User-Agent": UA,
      Origin: "https://9wktsbest.com",
      Referer: "https://9wktsbest.com/",
    },
  });
  console.log(`  status: ${piRes.status}`);
  const piText = await piRes.text();
  console.log(`  body:\n${piText}`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
