import * as fs from "fs";
import {
  createCloudflareBridge,
  type CaptureResult,
} from "@/lib/shared/cloudflare-bridge";


const PINNACLE_TOKEN_FILE = "sessions/betjili/pinnacle-token.json";

const PROACTIVE_REFRESH_BUFFER_MS = 20 * 60 * 1000;


export interface TokenData {
  token: string;
  refreshToken: string;
  capturedAt: string;
  expiresAt?: string;
}


const bridge = createCloudflareBridge({
  browserKey: "pinnacle.token-manager",
  siteUrl: "https://betjili365.com/bd/en",
  loginUrl: "https://betjili365.com/api/bt/v2_1/user/login",

  buildLoginBody: () => {
    const username = process.env.BETJILI_USERNAME;
    const password = process.env.BETJILI_PASSWORD;
    if (!username || !password) {
      throw new Error("Set BETJILI_USERNAME and BETJILI_PASSWORD in .env");
    }
    return {
      getIntercomInfo: true,
      languageTypeId: 1,
      currencyTypeId: 8,
      loginTypeId: 0,
      accessToken: "",
      userId: username,
      password,
      isBioLogin: false,
      fingerprint2: "96a5dbddb9f4d2a3fb938f9bf3d1c391",
      fingerprint4: "3cfe78c2633ed6b41ef9e83c6866ff29",
      browserHash: "da570c9355beac82ccd4e6ec22f63c91",
      deviceHash: "ad75c04f51946a8ffc154798f47b71e2",
      fbp: "",
      fbc: "",
      ttp: "",
      ttc: "",
      ttclid: "",
    };
  },

  extractAccessToken: (json) => {
    const data = (json as { data?: { accessToken?: string } }).data;
    return data?.accessToken ?? null;
  },

  gameUrlEndpoint: "https://betjili365.com/api/bt/v1/provider/getGameUrl",

  buildGameUrlBody: () => ({
    languageTypeId: 1,
    currencyTypeId: 8,
    gameTypeId: 4,
    vendorCode: "AWCV2_PINNACLE",
    isDesktop: 1,
    gameCode: "PINNACLE-SPORTS-001",
  }),

  processGameUrlResult: async (json, _accessToken, context) => {
    const data = (json as { data?: { gameUrl?: string } }).data;
    const gameUrl = data?.gameUrl;
    if (!gameUrl) return null;

    return new Promise<TokenData | null>(async (resolve) => {
      let resolved = false;
      const tokenPage = await context.newPage();

      tokenPage.on("response", async (response) => {
        if (resolved) return;
        const url = response.url();
        if (!url.includes("/player/auth/authentication")) return;

        try {
          const json = await response.json();
          if (json.success && json.data?.token) {
            const tokenData: TokenData = {
              token: json.data.token,
              refreshToken: json.data.refreshToken || "",
              capturedAt: new Date().toISOString(),
            };

            try {
              const payload = JSON.parse(
                Buffer.from(
                  json.data.token.replace("Bearer ", "").split(".")[1],
                  "base64",
                ).toString(),
              );
              if (payload.exp) {
                tokenData.expiresAt = new Date(
                  payload.exp * 1000,
                ).toISOString();
              }
            } catch {
            }

            resolved = true;
            try {
              await tokenPage.close();
            } catch {
            }
            resolve(tokenData);
          }
        } catch {
        }
      });

      try {
        await tokenPage.goto(gameUrl, {
          timeout: 20000,
          waitUntil: "domcontentloaded",
        });
        await tokenPage.waitForTimeout(5000);
      } catch {
      }

      if (!resolved) {
        try {
          await tokenPage.close();
        } catch {
        }
        resolve(null);
      }
    });
  },

  cfWaitMs: 5000,
});


export async function getPinnacleToken(
  forceRefresh = false,
  skipCapture = false,
): Promise<string | null> {
  if (!forceRefresh) {
    const storedToken = getStoredToken();
    if (storedToken && isTokenValid()) return storedToken;
  }
  if (skipCapture) return null;

  const tokenData = await captureToken();
  return tokenData?.token || null;
}

export function isTokenValid(): boolean {
  try {
    if (!fs.existsSync(PINNACLE_TOKEN_FILE)) return false;
    const data: TokenData = JSON.parse(
      fs.readFileSync(PINNACLE_TOKEN_FILE, "utf-8"),
    );
    if (!data.expiresAt) return true;

    const expiresAt = new Date(data.expiresAt);
    const bufferMs = 5 * 60 * 1000;
    return expiresAt.getTime() - bufferMs > Date.now();
  } catch {
    return false;
  }
}

export function getStoredToken(): string | null {
  try {
    if (!fs.existsSync(PINNACLE_TOKEN_FILE)) return null;
    const data: TokenData = JSON.parse(
      fs.readFileSync(PINNACLE_TOKEN_FILE, "utf-8"),
    );
    return data.token;
  } catch {
    return null;
  }
}

export function clearStoredToken(): void {
  try {
    if (fs.existsSync(PINNACLE_TOKEN_FILE)) fs.unlinkSync(PINNACLE_TOKEN_FILE);
  } catch {
  }
}

export function getTokenTTL(): number | null {
  try {
    if (!fs.existsSync(PINNACLE_TOKEN_FILE)) return null;
    const data: TokenData = JSON.parse(
      fs.readFileSync(PINNACLE_TOKEN_FILE, "utf-8"),
    );
    if (!data.expiresAt) return null;
    return new Date(data.expiresAt).getTime() - Date.now();
  } catch {
    return null;
  }
}

export function shouldRefreshProactively(): boolean {
  const ttl = getTokenTTL();
  if (ttl === null) return false;
  return ttl < PROACTIVE_REFRESH_BUFFER_MS && ttl > 0;
}

export async function refreshTokenIfNeeded(): Promise<boolean> {
  if (!shouldRefreshProactively()) return false;

  try {
    const tokenData = await captureToken();
    if (tokenData) return true;
    console.warn(
      "[TokenManager] Proactive refresh failed — will retry on next sync",
    );
    return false;
  } catch (error) {
    console.error("[TokenManager] Proactive refresh error:", error);
    return false;
  }
}

export async function closeBrowser(): Promise<void> {
  await bridge.shutdown();
}


async function captureToken(): Promise<TokenData | null> {
  try {
    const startMs = Date.now();
    const result: CaptureResult = await bridge.capture();
    const tokenData = result.providerData as TokenData | null;

    if (tokenData) {
      const dir = "sessions/betjili";
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PINNACLE_TOKEN_FILE, JSON.stringify(tokenData, null, 2));

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(
        `[TokenManager] ✅ Token captured in ${elapsed}s — ` +
          `expires ${tokenData.expiresAt ?? "unknown"}`,
      );
    }

    return tokenData;
  } catch (error) {
    console.error("[TokenManager] Error during token capture:", error);
    return null;
  }
}
