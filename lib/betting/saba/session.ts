import * as fs from "fs";
import * as path from "path";
import type { SabaSession } from "./types";
import {
  createCloudflareBridge,
  type CaptureResult,
} from "@/lib/shared/cloudflare-bridge";
import {
  buildBetconstructLoginBody,
  decodeJwtExp,
  extractBetconstructAccessToken,
  extractBetconstructRefreshToken,
  isBetconstructHardLoginFailure,
} from "@/lib/betting/shared/betconstruct-login";

const SESSION_FILE = path.join("sessions", "saba", "session.json");
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const SABA_SITE_URL = "https://fwjili.com/bd/bn";
const SABA_LOGIN_URL = "https://fwjili.com/api/bt/v2_1/user/login";

function readFancyWinCredentials(): { username: string; password: string } {
  const username = process.env.FANCYWIN_USERNAME ?? process.env.SABA_USERNAME;
  const password = process.env.FANCYWIN_PASSWORD ?? process.env.SABA_PASSWORD;
  if (!username || !password) {
    throw new Error("FANCYWIN_USERNAME / FANCYWIN_PASSWORD missing from .env");
  }
  return { username, password };
}

const bridge = createCloudflareBridge({
  browserKey: "saba.session",
  siteUrl: SABA_SITE_URL,
  loginUrl: SABA_LOGIN_URL,

  buildLoginBody: () => {
    const { username: userId, password } = readFancyWinCredentials();
    return buildBetconstructLoginBody({
      languageTypeId: 8,
      currencyTypeId: 8,
      userId,
      password,
    });
  },

  extractAccessToken: extractBetconstructAccessToken,
  isHardLoginFailure: isBetconstructHardLoginFailure,
  gameUrlEndpoint: "https://fwjili.com/api/bt/v1/provider/getGameUrl",

  buildGameUrlBody: () => ({
    languageTypeId: 8,
    currencyTypeId: 8,
    gameTypeId: 64,
    vendorCode: "Saba",
    isDesktop: 1,
    gameCode: "1",
    extraData: "1",
  }),

  processGameUrlResult: async (json) => {
    const data = (json as { data?: { gameUrl?: string } }).data;
    const gameUrl = data?.gameUrl;
    if (!gameUrl) return null;
    return { gameUrl };
  },

  cfWaitMs: 4000,
});

let inflight: Promise<SabaSession> | null = null;

export async function getSession(forceRefresh = false): Promise<SabaSession> {
  if (!forceRefresh) {
    const cached = readStoredSession();
    if (cached && !isExpiring(cached)) return cached;
  }
  if (inflight) return inflight;
  inflight = captureSession().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function invalidateSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch {
  }
}

export async function shutdownSessionBrowser(): Promise<void> {
  await bridge.shutdown();
}

export async function captureSession(): Promise<SabaSession> {
  const { username } = readFancyWinCredentials();

  const result: CaptureResult = await bridge.capture();
  const providerData = result.providerData as { gameUrl: string };

  const session: SabaSession = {
    username,
    accessToken: result.accessToken,
    refreshToken: extractBetconstructRefreshToken(result.loginResponse),
    accessTokenExp: decodeJwtExp(result.accessToken),
    gameUrl: providerData.gameUrl,
    capturedAt: new Date().toISOString(),
  };

  writeStoredSession(session);
  return session;
}

function readStoredSession(): SabaSession | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    return JSON.parse(raw) as SabaSession;
  } catch {
    return null;
  }
}

function writeStoredSession(s: SabaSession): void {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function isExpiring(s: SabaSession): boolean {
  if (!s.accessTokenExp) return true;
  const expMs = s.accessTokenExp * 1000;
  return Date.now() > expMs - REFRESH_BUFFER_MS;
}
