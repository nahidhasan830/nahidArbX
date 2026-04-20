/**
 * 9wkts (NineWickets) session manager.
 *
 * 9wktsbest.com is Cloudflare-walled, so login runs through Playwright.
 * The exchange hosts (gakvx/gakqv.seofmi.live) are plain HTTP and take
 * the captured jsessionid, so everything after login stays in Node.
 *
 * Lifecycle:
 *   getSession()   returns a valid cached session; refreshes when expired
 *   captureSession()  one-shot Playwright login; persists to disk
 *   invalidateSession() wipes the cache — call on 401/403 from exchange
 */
import { chromium, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";
import type { NineWicketsSession } from "./types";
import {
  getAutoLoginConfig,
  AutoLoginDisabledError,
} from "./auto-login-config";
import {
  closeSingletonBrowser,
  getSingletonBrowser,
  registerSingletonBrowser,
} from "@/lib/shared/playwright-singleton";

// Stable key for the hot-reload-safe browser registry. Any module-level
// reference here would get orphaned on every Next.js file save; the
// registry lives on globalThis and survives HMR.
const BROWSER_KEY = "ninewickets.session";

const SESSION_FILE = path.join("sessions", "9wkts", "session.json");
const LOGIN_URL = "https://9wktsbest.com/bd/en/login";
const EXCHANGE_LOBBY_URL = "https://9wktsbest.com/bd/en/EXSport";

// Refresh if access token is within this window of expiry.
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

let inflight: Promise<NineWicketsSession> | null = null;

// Inflight-launch dedupe. Browser ref itself lives in the global
// registry (see BROWSER_KEY) so it survives HMR — but we still need a
// module-local promise to coalesce concurrent callers during the
// initial cold launch.
let warmBrowserInflight: Promise<Browser> | null = null;

async function getWarmBrowser(): Promise<Browser> {
  const existing = getSingletonBrowser(BROWSER_KEY);
  if (existing) {
    // HMR reload path: Chromium is still warm from a previous module
    // lifetime, but its old BrowserContexts are dead weight. Close
    // them before the next capture opens its own.
    for (const ctx of existing.contexts()) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
    return existing;
  }
  if (warmBrowserInflight) return warmBrowserInflight;
  const headless = process.env.TOKEN_HEADLESS !== "false";
  warmBrowserInflight = chromium
    .launch({ headless })
    .then(async (b) => {
      await registerSingletonBrowser(BROWSER_KEY, b);
      return b;
    })
    .finally(() => {
      warmBrowserInflight = null;
    });
  return warmBrowserInflight;
}

/** Shut down the persistent browser if running. */
export async function shutdownSessionBrowser(): Promise<void> {
  warmBrowserInflight = null;
  await closeSingletonBrowser(BROWSER_KEY);
}

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

export async function captureSession(): Promise<NineWicketsSession> {
  const username = process.env.NINEWICKETS_USERNAME;
  const password = process.env.NINEWICKETS_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "NINEWICKETS_USERNAME / NINEWICKETS_PASSWORD missing from .env",
    );
  }

  // Reuse a persistent Chromium instance — cold-launching burns 3-5s
  // per capture which directly eats into our kick-off recovery SLO.
  // Each login still gets its own fresh context so cookies/JWTs don't
  // bleed across runs.
  const browser = await getWarmBrowser();
  let ctx: import("playwright").BrowserContext | null = null;

  try {
    ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();

    // ── Network listeners installed BEFORE any navigation ──
    // The JWT isn't always in localStorage after this site's recent
    // UI updates, but it's reliably in the login response body.
    // Similarly, the jsessionid (+ .vkplayerNN suffix) always shows up
    // on the Authorization header of any subsequent seofmi.live XHR,
    // even when localStorage.queryPass is empty.
    type JwtCapture = {
      accessToken: string;
      refreshToken: string;
      exp: number;
    };
    // Use an object wrapper so TS control-flow doesn't narrow the
    // outer `let` to `never` after the closure assignment.
    const jwtRef: { current: JwtCapture | null } = { current: null };
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/bt/") && url.includes("/user/login")) {
        res
          .text()
          .then((body) => {
            try {
              const parsed = JSON.parse(body);
              const data = parsed?.data ?? parsed;
              const accessToken = data?.accessToken ?? "";
              const refreshToken = data?.refreshToken ?? "";
              const exp = Number(data?.accessTokenExp ?? 0);
              if (accessToken) {
                jwtRef.current = { accessToken, refreshToken, exp };
              }
            } catch {
              // ignore
            }
          })
          .catch(() => {
            // body might not be readable for non-2xx, ignore
          });
      }
    });

    let queryPassFromHeader: string | null = null;
    page.on("request", (req) => {
      if (queryPassFromHeader) return;
      const u = req.url();
      if (!u.includes("seofmi.live")) return;
      const auth = req.headers()["authorization"];
      if (auth && auth.includes("vkplayer")) {
        queryPassFromHeader = auth;
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    await page.fill('input[name="userId"]', username);
    await page.fill('input[name="password"]', password);

    // Submit via Enter — the popup "Login" is a plain div, and Enter on
    // the focused password field fires the same submit handler reliably.
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/bt/") && r.url().includes("/user/login"),
        { timeout: 30000 },
      ),
      page.press('input[name="password"]', "Enter"),
    ]);

    // The jsessionid (queryPass) is created on the frontend's first
    // exchange-API call — forcing a lobby nav triggers the handshake.
    await page
      .goto(EXCHANGE_LOBBY_URL, { waitUntil: "domcontentloaded" })
      .catch(() => {
        // hash-only nav can 'fail' — ignore
      });

    // Give the JWT-response listener a moment to fire + flush.
    await page.waitForTimeout(250);

    const deadline = Date.now() + 30000;
    let captured: NineWicketsSession | null = null;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) ?? "";
          out[k] = localStorage.getItem(k) ?? "";
        }
        return out;
      });
      // Prefer the network-captured values (more reliable than
      // localStorage, which sometimes holds empty strings after
      // recent UI updates).
      const jwt = jwtRef.current;
      const queryPass = queryPassFromHeader ?? snapshot.queryPass ?? "";
      const accessToken = jwt?.accessToken ?? snapshot.accessToken ?? "";
      const refreshToken = jwt?.refreshToken ?? snapshot.refreshToken ?? "";
      const accessTokenExp = Number(jwt?.exp ?? snapshot.accessTokenExp ?? 0);
      if (queryPass && accessToken) {
        captured = {
          username,
          queryPass,
          accessToken,
          refreshToken,
          accessTokenExp,
          capturedAt: new Date().toISOString(),
        };
        break;
      }
      await page.waitForTimeout(500);
    }

    if (!captured) {
      // Warm-browser reuse has a failure mode: once Chromium's
      // accumulated state goes sour (Cloudflare challenge cached on
      // the browser-level fingerprint, a crashed renderer that
      // stayed "connected", etc.) every subsequent capture on the
      // same instance also fails. The test script works with a fresh
      // browser; ours keeps reusing a bad one. Dispose it here so
      // the next call launches cold.
      await disposeWarmBrowser();
      throw new Error(
        "9wkts session capture failed: could not capture queryPass + accessToken " +
          "from either network or localStorage within 30s",
      );
    }

    writeStoredSession(captured);
    return captured;
  } catch (err) {
    // Same reasoning as the timeout branch — any capture failure
    // (navigation timeout, login-response error, stream aborted)
    // taints the warm browser. Reset so the next attempt starts
    // with a clean Chromium process.
    await disposeWarmBrowser();
    throw err;
  } finally {
    // Close the context (page + cookies) but keep the browser warm
    // for the next capture attempt.
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore — context may already be gone if the browser died
      }
    }
  }
}

/**
 * Tear down the persistent Chromium instance so the next capture
 * launches fresh. Safe to call concurrently with an in-flight launch
 * — `closeSingletonBrowser` clears the registry entry up-front so a
 * concurrent caller sees "no browser" and launches its own.
 */
async function disposeWarmBrowser(): Promise<void> {
  warmBrowserInflight = null;
  await closeSingletonBrowser(BROWSER_KEY);
}

// -------------------------------------------------------------------------
// Storage
// -------------------------------------------------------------------------

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
