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


const SESSION_FILE = path.join("sessions", "9wkts", "session.json");

const REFRESH_BUFFER_MS = 10 * 60 * 1000;


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

  processGameUrlResult: async (json) => {
    const data = (json as { data?: { gameUrl?: string } }).data;
    const queryPass = data?.gameUrl;
    if (!queryPass) return null;
    return { queryPass };
  },
});


let inflight: Promise<NineWicketsSession> | null = null;


export async function getSession(
  forceRefresh = false,
): Promise<NineWicketsSession> {
  if (!forceRefresh) {
    const cached = readStoredSession();
    if (cached && !isExpiring(cached)) return cached;
  }
  const autoConfig = getAutoLoginConfig();
  if (!autoConfig.enabled) {
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
  }
}

export async function shutdownSessionBrowser(): Promise<void> {
  await bridge.shutdown();
}


export async function captureSession(): Promise<NineWicketsSession> {
  const username = process.env.NINEWICKETS_USERNAME;
  if (!username) {
    throw new Error("NINEWICKETS_USERNAME missing from .env");
  }

  const result: CaptureResult = await bridge.capture();
  const { queryPass } = result.providerData as { queryPass: string };

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
