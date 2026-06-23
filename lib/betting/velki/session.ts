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

async function captureWithRetries(): Promise<VelkiSession> {
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
  }
}

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


export async function captureSession(): Promise<VelkiSession> {
  const username = process.env.VELKI_USERNAME;
  const password = process.env.VELKI_PASSWORD;
  if (!username || !password) {
    throw new Error("VELKI_USERNAME / VELKI_PASSWORD missing from .env");
  }

  captureStarted("velki-sportsbook");

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
    throw new Error(
      "[Velki] game-launch returned null data (rate-limited, will retry)",
    );
  }
  return parsed.data.gameUrl;
}

async function captureJsessionid(gameUrl: string): Promise<string> {
  return captureCookieFromRedirects({
    startUrl: gameUrl,
    cookieName: "JSESSIONID",
    headers: BROWSER_HEADERS_MAIN,
    label: "Velki SSO bridge",
  });
}


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
