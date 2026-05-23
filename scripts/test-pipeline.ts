/**
 * Pipeline integration test — exercises settlement + auto-placement
 * through the live HTTP API of the running dev/prod server.
 *
 * Tests the ACTUAL wiring, not isolated library calls:
 *   1. Settlement: POST /api/settlement {"action":"run"}
 *      → runs runAutoSettle(), writes P&L, fires Telegram for placed bets
 *   2. Auto-placement: POST /api/value-bets {"action":"syncNow"}
 *      → runs full sync pipeline, persists value bets, calls maybeAutoPlace
 *
 * Usage:
 *   npx tsx scripts/test-pipeline.ts
 *   npx tsx scripts/test-pipeline.ts http://localhost:3001   (custom port)
 */

import "dotenv/config";

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");

async function api<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} — ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function hr(label: string) {
  const pad = "─".repeat(Math.max(0, 52 - label.length));
  console.log(`\n── ${label} ${pad}`);
}

type SettleResult = {
  scannedBets: number;
  settled: number;
  applied: number;
  stillPending: number;
  errors: string[];
  telemetry: {
    tier0_hits: number;
    tier1_hits: number;
    tier2_hits: number;
    tier3_hits: number;
    durationMs: number;
    settledDeterministically: number;
  };
};

async function main() {
  // ── 1. Health check ─────────────────────────────────────────────────────
  hr("1 / Server health");
  try {
    const h = await api<{ status: string }>("GET", "/api/health");
    console.log(`  server: ${h.status ?? "ok"}`);
  } catch {
    console.error(`  ✗ Server not reachable at ${BASE}`);
    console.error("    Start the dev server first: npm run dev");
    process.exit(1);
  }

  // ── 2. Auto-place config ─────────────────────────────────────────────────
  hr("2 / Auto-place config");
  const apRes = await api<{
    providers: {
      provider: string;
      providerDisplayName: string;
      enabled: boolean;
    }[];
  }>("GET", "/api/auto-place");

  for (const p of apRes.providers) {
    const toggle = p.enabled ? "ON  ✓" : "OFF ✗";
    console.log(`  ${toggle}  ${p.providerDisplayName} (${p.provider})`);
  }

  const anyOn = apRes.providers.some((p) => p.enabled);
  if (!anyOn) {
    console.log(
      "\n  ⚠  Auto-place is OFF for all providers.\n" +
        "     To test placement, enable it:\n" +
        `     curl -s -X POST ${BASE}/api/auto-place \\\n` +
        `       -H 'Content-Type: application/json' \\\n` +
        `       -d '{"provider":"ninewickets-sportsbook","enabled":true}'`,
    );
  }

  // ── 3. Settlement — single tick ──────────────────────────────────────────
  hr("3 / Settlement pipeline (single tick)");
  console.log("  Calling POST /api/settlement {action:run} …");

  let settleResult: SettleResult | undefined;
  try {
    const raw = await api<{ ok: boolean; data: { result: SettleResult } }>(
      "POST",
      "/api/settlement",
      { action: "run" },
    );
    settleResult = raw.data?.result;
  } catch (e) {
    console.error(`  ✗ Settlement trigger failed: ${(e as Error).message}`);
  }

  if (settleResult) {
    const r = settleResult;
    console.log(`  Scanned:       ${r.scannedBets} pending bets`);
    console.log(
      `  Resolved:      ${r.settled} (deterministic: ${r.telemetry.settledDeterministically})`,
    );
    console.log(`  Applied:       ${r.applied} (DB rows written)`);
    console.log(`  Still pending: ${r.stillPending}`);
    console.log(
      `  Tier hits:     T0=${r.telemetry.tier0_hits} T1=${r.telemetry.tier1_hits} T2=${r.telemetry.tier2_hits}`,
    );
    console.log(`  Duration:      ${r.telemetry.durationMs}ms`);

    if (r.errors.length > 0) {
      console.log(`  ⚠  Errors: ${r.errors.join("; ")}`);
    }

    if (r.applied > 0) {
      console.log(
        `\n  ✓ ${r.applied} placed bet(s) settled — check Telegram for notifications.`,
      );
    } else if (r.scannedBets === 0) {
      console.log(
        "  ℹ  No bets ready to settle yet (kickoff + 2h15m threshold).",
      );
    } else {
      console.log(
        `  ℹ  ${r.scannedBets} bets scanned but 0 applied — scores not yet available.`,
      );
    }
  }

  // ── 4. Sync (triggers auto-placement) ───────────────────────────────────
  hr("4 / Sync pipeline (auto-placement)");
  console.log("  Calling POST /api/value-bets {action:syncNow} …");

  try {
    await api("POST", "/api/value-bets", { action: "syncNow" });
    console.log("  Sync kicked off (background).");
    console.log(
      "  Watch server logs for: AutoPlacer [provider] → placed|skipped",
    );
    if (anyOn) {
      console.log(
        "  Auto-place is ON — placed bets will trigger a Telegram alert.",
      );
    }
  } catch (e) {
    console.error(`  ✗ Sync trigger failed: ${(e as Error).message}`);
  }

  // ── 5. Summary ───────────────────────────────────────────────────────────
  hr("Summary");
  console.log("  Settlement notifications:");
  if (settleResult && settleResult.applied > 0) {
    console.log(
      `    ✓ ${settleResult.applied} notification(s) fired — check Telegram`,
    );
  } else {
    console.log(
      "    – No placed bets settled this tick (no new Telegram messages expected)",
    );
  }

  console.log("  Auto-placement:");
  if (anyOn) {
    console.log("    ✓ Enabled — check server logs for AutoPlacer output");
  } else {
    console.log("    – Disabled — enable a provider to test placement");
  }
  console.log("");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
