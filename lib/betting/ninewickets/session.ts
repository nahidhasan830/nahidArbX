/**
 * 9wkts (NineWickets) session manager.
 *
 * Uses the shared Cloudflare bridge pipeline:
 *   Step 0 – Navigate to 9wktsbest.com → CF solves automatically
 *   Step 1 – page.evaluate(fetch('/login'))       → accessToken
 *   Step 2 – page.evaluate(fetch('/getGameUrl'))  → queryPass (jsessionid)
 *
 * No form filling, no lobby navigation, no localStorage polling, no
 * network interception. ~5s total. The exchange hosts (gakvx/gakqv.seofmi.live)
 * are plain HTTP and take the captured queryPass directly.
 *
 * Lifecycle:
 *   getSession()        returns a valid cached session; refreshes when expired
 *   captureSession()    one-shot CF-solve + API login; persists to disk
 *   invalidateSession() wipes the cache — call on 401/403 from exchange
 */
import * as fs from "fs";
import * as path from "path";
import type { NineWicketsSession } from "./types";
import {
  getAutoLoginConfig,
  AutoLoginDisabledError,
} from "./auto-login-config";
import {
  createCloudflareBridge,
  type CaptureResult,
} from "@/lib/shared/cloudflare-bridge";
import {
  buildBetconstructLoginBody,
  decodeJwtExp,
  extractBetconstructAccessToken,
} from "@/lib/betting/shared/betconstruct-login";

// ── Constants ────────────────────────────────────────────────────────────

const SESSION_FILE = path.join("sessions", "9wkts", "session.json");

/** Refresh if access token is within this window of expiry. */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

// ── Bridge instance ──────────────────────────────────────────────────────

const bridge = createCloudflareBridge({
  browserKey: "ninewickets.session",
  siteUrl: "https://9wktsbest.com/bd/en",
  loginUrl: "https://9wktsbest.com/api/bt/v2_1/user/login",

  buildLoginBody: () => {
    const userId = process.env.NINEWICKETS_USERNAME;
    const password = process.env.NINEWICKETS_PASSWORD;
    if (!userId || !password) {
      throw new Error(
        "NINEWICKETS_USERNAME / NINEWICKETS_PASSWORD missing from .env",
      );
    }
    return {
      ...buildBetconstructLoginBody({
        languageTypeId: 1,
        currencyTypeId: 8,
        userId,
        password,
      }),
      userId,
      password,
    };
  },

  extractAccessToken: extractBetconstructAccessToken,

  gameUrlEndpoint: "https://9wktsbest.com/api/bt/v1/provider/getGameUrl",

  buildGameUrlBody: () => ({
    languageTypeId: 1,
    currencyTypeId: 8,
    gameTypeId: 4,
    vendorCode: "CRICKETV2",
    gameCode: "CRICKETV2",
  }),

  // The CRICKETV2 vendor returns the jsessionid (queryPass) directly
  // as the gameUrl value — no redirect following needed.
  processGameUrlResult: async (json) => {
    const data = (json as { data?: { gameUrl?: string } }).data;
    const queryPass = data?.gameUrl;
    if (!queryPass) return null;
    return { queryPass };
  },
});

// ── Concurrency guard ────────────────────────────────────────────────────

let inflight: Promise<NineWicketsSession> | null = null;

// ── Public API ───────────────────────────────────────────────────────────

export async function getSession(
  forceRefresh = false,
): Promise<NineWicketsSession> {
  if (!forceRefresh) {
    const cached = readStoredSession();
    if (cached && !isExpiring(cached)) return cached;
  }
  // Auto-login kill switch — when the operator is using 9W manually,
  // they flip this off so our Playwright login doesn't kick them off.
  const autoConfig = getAutoLoginConfig();
  if (!autoConfig.enabled) {
    // If we have an expiring-but-usable cached session, hand it back
    // rather than failing — the caller can decide how strict to be.
    const cached = readStoredSession();
    if (cached) return cached;
    throw new AutoLoginDisabledError(autoConfig.reason);
  }
  if (inflight) return inflight;
  inflight = captureSession().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function invalidateSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // ignore
  }
}

/** Shut down the persistent browser if running. */
export async function shutdownSessionBrowser(): Promise<void> {
  await bridge.shutdown();
}

// ── Capture flow ─────────────────────────────────────────────────────────

export async function captureSession(): Promise<NineWicketsSession> {
  const username = process.env.NINEWICKETS_USERNAME;
  if (!username) {
    throw new Error("NINEWICKETS_USERNAME missing from .env");
  }

  const result: CaptureResult = await bridge.capture();
  const { queryPass } = result.providerData as { queryPass: string };

  // Decode JWT exp from accessToken
  const accessTokenExp = decodeJwtExp(result.accessToken);

  const session: NineWicketsSession = {
    username,
    queryPass,
    accessToken: result.accessToken,
    refreshToken: "", // Not needed for exchange API calls
    accessTokenExp,
    capturedAt: new Date().toISOString(),
  };

  writeStoredSession(session);
  return session;
}

// ── Storage ──────────────────────────────────────────────────────────────

function readStoredSession(): NineWicketsSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    return JSON.parse(raw) as NineWicketsSession;
  } catch {
    return null;
  }
}

function writeStoredSession(s: NineWicketsSession) {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function isExpiring(s: NineWicketsSession): boolean {
  if (!s.accessTokenExp) return true;
  const expMs = s.accessTokenExp * 1000;
  return Date.now() > expMs - REFRESH_BUFFER_MS;
}
