/**
 * Test Velki end-to-end session capture + balance read.
 *
 * Verifies the full chain:
 *   1. POST  /account/login              → DRF token
 *   2. GET   /game/game-launch/WK/SB     → signed gameUrl
 *   3. GET   <gameUrl>                   → JSESSIONID cookie
 *   4. POST  /member/playerService/queryPlayerInfo
 *                                        → provider-tier wallet
 *
 * Run with:  npx tsx scripts/test-velki-session.ts
 */
import "dotenv/config";
import {
  captureSession,
  invalidateSession,
} from "../lib/betting/velki/session";
import { queryPlayerInfo } from "../lib/betting/velki/client";

async function main() {
  console.log("→ wiping any cached session so we test the full chain");
  invalidateSession();

  console.log("→ capturing fresh session (login → game-launch → JSESSIONID)");
  const session = await captureSession();
  console.log("✓ session captured");
  console.log({
    username: session.username,
    tokenPreview: `${session.token.slice(0, 8)}…${session.token.slice(-4)}`,
    jsessionid: session.jsessionid,
    capturedAt: session.capturedAt,
  });

  console.log("→ POST queryPlayerInfo (provider tier)");
  const info = await queryPlayerInfo();
  console.log("✓ provider-tier wallet:");
  console.log({
    betCredit: info.betCredit,
    creditAllocated: info.creditAllocated,
    totalExposure: info.totalExposure,
    minBet: info.minBet,
    accountSuspended: info.accountSuspended,
    accountSysSuspended: info.accountSysSuspended,
  });
}

main().catch((err) => {
  console.error("✗ failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
