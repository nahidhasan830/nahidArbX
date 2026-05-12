/**
 * Velki session manager.
 *
 * Unlike NineWickets — which sits behind Cloudflare and forces a
 * Playwright login — Velki's auth surface is plain JSON HTTP. The full
 * lifecycle stays in Node:
 *
 *   1. POST vk-sa.softtake.net/account/login   → DRF token (main tier)
 *   2. GET  vk-sa.softtake.net/game/game-launch/WK/SB?operator=gs&game_id=9weiket
 *           with Authorization: Token <token>  → signed gameUrl
 *   3. GET  <gameUrl> with redirect: 'manual'  → Set-Cookie: JSESSIONID=<...>
 *
 * The captured JSESSIONID is then used (raw, in both the URL path
 * `;jsessionid=…` and the Authorization header) for every subsequent
 * provider-tier call to saapipl.fwick7ets.xyz.
 *
 * Lifecycle:
 *   getSession()         valid cached session, or refresh on demand
 *   captureSession()     run all 3 steps fresh; persist to disk
 *   invalidateSession()  wipe cache — call on any 401/403 / 1001
 *
 * Token lifetimes are unverified at time of writing; we treat both
 * tokens as opaque and simply re-capture on any auth failure. Wrap
 * provider-tier calls with `callWithSessionRetry` (mirrors the 9W
 * pattern) so a single transient 401 → re-login → retry.
 */
import * as fs from "fs";
import * as path from "path";
import { validateAndParse } from "../../shared/validation";
import { captureCookieFromRedirects } from "../../shared/cookie-capture";
import {
  VelkiGameLaunchResponseSchema,
  VelkiLoginResponseSchema,
} from "../../shared/schemas/velki";
import type { VelkiSession } from "./types";
import {
  getVelkiAutoLoginConfig,
  VelkiAutoLoginDisabledError,
} from "./auto-login-config";
import {
  captureStarted,
  stepCompleted,
  stepFailed,
  captureSucceeded,
  captureFailed,
} from "../../shared/session-diagnostics";

const SESSION_FILE = path.join("sessions", "velki", "session.json");

const MAIN_HOST = "https://vk-sa.softtake.net";
const VELKI_ORIGIN = "https://velki.live";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// Browser-shaped headers. The provider tier appears to be sensitive to
// missing Origin/Referer (mirrors 9W's WAF behaviour); set them on
// every call to be safe.
const BROWSER_HEADERS_MAIN: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: VELKI_ORIGIN,
  Referer: `${VELKI_ORIGIN}/`,
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

let inflight: Promise<VelkiSession> | null = null;

// =====================================================================
// Public API
// =====================================================================

export class VelkiSessionExpiredError extends Error {
  constructor(message: string) {
    super(`[Velki] session expired: ${message}`);
    this.name = "VelkiSessionExpiredError";
  }
}

export async function getSession(forceRefresh = false): Promise<VelkiSession> {
  if (!forceRefresh) {
    const cached = readStoredSession();
    if (cached) return cached;
  }
  // Auto-login kill switch: if the operator paused auto-login (because
  // they're working on Velki manually elsewhere), don't race them by
  // running the 3-step capture chain. Surface a typed error so callers
  // can distinguish "intentionally paused" from "login failed".
  const config = getVelkiAutoLoginConfig();
  if (!config.enabled) {
    throw new VelkiAutoLoginDisabledError(config.reason);
  }
  if (inflight) return inflight;
  inflight = captureWithRetries().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Wrap `captureSession` in retry-with-backoff. The 3-step chain
 * (login → game-launch → JSESSIONID) is brittle — any of the three
 * legs can transiently fail (network blip, WAF rate limit, gameUrl
 * single-use token race). Two retries (3 attempts total) clear the
 * vast majority of transient failures without papering over a real
 * outage. Backoff is short — these are seconds, not minutes —
 * because the caller is usually waiting on a sync cycle.
 */
async function captureWithRetries(): Promise<VelkiSession> {
  // The game-launch endpoint enforces an aggressive rate limit that
  // returns data:null when called too frequently (e.g. rapid re-login
  // after a session-expired retry). Use generous backoffs to let the
  // server cool down between attempts.
  const MAX_ATTEMPTS = 5;
  const BACKOFF_MS = [0, 3000, 6000, 10000, 15000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (BACKOFF_MS[attempt] > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
    try {
      const session = await captureSession();
      captureSucceeded("velki-sportsbook");
      return session;
    } catch (err) {
      lastErr = err;
      // Hard auth failure (bad password, account suspended) should not
      // retry — the message is signal, not a transient bug.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("refused")) {
        captureFailed("velki-sportsbook", msg);
        throw err;
      }
    }
  }
  const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  captureFailed("velki-sportsbook", finalMsg);
  throw lastErr ?? new Error("[Velki] capture failed after retries");
}

export function invalidateSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
    // ignore — best-effort wipe
  }
}

/**
 * Provider-tier call wrapper. Runs `fn` with the current session; on
 * VelkiSessionExpiredError, wipes the cache, re-captures, and retries
 * exactly once. Mirrors the 9W `callWithSessionRetry` shape so the
 * provider client can stay symmetric.
 */
export async function callWithSessionRetry<T>(
  fn: (session: VelkiSession) => Promise<T>,
): Promise<T> {
  const session = await getSession();
  try {
    return await fn(session);
  } catch (err) {
    if (err instanceof VelkiSessionExpiredError) {
      invalidateSession();
      const fresh = await getSession(true);
      return await fn(fresh);
    }
    throw err;
  }
}

// =====================================================================
// Capture flow (3 HTTP steps, no browser)
// =====================================================================

export async function captureSession(): Promise<VelkiSession> {
  const username = process.env.VELKI_USERNAME;
  const password = process.env.VELKI_PASSWORD;
  if (!username || !password) {
    throw new Error("VELKI_USERNAME / VELKI_PASSWORD missing from .env");
  }

  captureStarted("velki-sportsbook");

  // Step 1 — main-tier login → DRF token
  let token: string;
  let t0 = Date.now();
  try {
    token = await loginForToken(username, password);
    stepCompleted("velki-sportsbook", "login", Date.now() - t0);
  } catch (err) {
    stepFailed(
      "velki-sportsbook",
      "login",
      err instanceof Error ? err.message : String(err),
      Date.now() - t0,
    );
    throw err;
  }

  // Step 2 — exchange token for a one-shot signed gameUrl
  let gameUrl: string;
  t0 = Date.now();
  try {
    gameUrl = await fetchGameLaunchUrl(token);
    stepCompleted("velki-sportsbook", "game-launch", Date.now() - t0);
  } catch (err) {
    stepFailed(
      "velki-sportsbook",
      "game-launch",
      err instanceof Error ? err.message : String(err),
      Date.now() - t0,
    );
    throw err;
  }

  // Step 3 — follow gameUrl manually to capture JSESSIONID
  let jsessionid: string;
  t0 = Date.now();
  try {
    jsessionid = await captureJsessionid(gameUrl);
    stepCompleted("velki-sportsbook", "jsessionid", Date.now() - t0);
  } catch (err) {
    stepFailed(
      "velki-sportsbook",
      "jsessionid",
      err instanceof Error ? err.message : String(err),
      Date.now() - t0,
    );
    throw err;
  }

  const session: VelkiSession = {
    username,
    token,
    jsessionid,
    capturedAt: new Date().toISOString(),
  };
  writeStoredSession(session);
  return session;
}

async function loginForToken(
  username: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${MAIN_HOST}/account/login`, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS_MAIN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(`[Velki] login HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const parsed = validateAndParse(
    body,
    VelkiLoginResponseSchema,
    "[Velki] login",
  );
  if (!parsed) throw new Error("[Velki] login response failed validation");
  if (!parsed.success || parsed.errcode !== "0") {
    throw new Error(
      `[Velki] login refused: ${parsed.message} (errcode=${parsed.errcode})`,
    );
  }
  return parsed.data.token;
}

async function fetchGameLaunchUrl(token: string): Promise<string> {
  const res = await fetch(
    `${MAIN_HOST}/game/game-launch/WK/SB?operator=gs&game_id=9weiket`,
    {
      method: "GET",
      headers: {
        ...BROWSER_HEADERS_MAIN,
        Authorization: `Token ${token}`,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`[Velki] game-launch HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const parsed = validateAndParse(
    body,
    VelkiGameLaunchResponseSchema,
    "[Velki] game-launch",
  );
  if (!parsed)
    throw new Error("[Velki] game-launch response failed validation");
  if (!parsed.success || parsed.errcode !== "0") {
    throw new Error(
      `[Velki] game-launch refused: ${parsed.message} (errcode=${parsed.errcode})`,
    );
  }
  if (!parsed.data?.gameUrl) {
    // The game-launch endpoint sometimes returns success:true but
    // data:null when rate-limited. This is transient — NOT a hard
    // auth refusal — so use a message that does NOT contain "refused"
    // to allow captureWithRetries to retry.
    throw new Error(
      "[Velki] game-launch returned null data (rate-limited, will retry)",
    );
  }
  return parsed.data.gameUrl;
}

async function captureJsessionid(gameUrl: string): Promise<string> {
  // The bridge endpoint may set JSESSIONID on the redirect itself or
  // on a subsequent hop. The shared helper handles the redirect chain
  // + cookie harvesting; we just hand it the URL and headers.
  return captureCookieFromRedirects({
    startUrl: gameUrl,
    cookieName: "JSESSIONID",
    headers: BROWSER_HEADERS_MAIN,
    label: "Velki SSO bridge",
  });
}

// =====================================================================
// Storage
// =====================================================================

function readStoredSession(): VelkiSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    return JSON.parse(raw) as VelkiSession;
  } catch {
    return null;
  }
}

function writeStoredSession(s: VelkiSession): void {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}
