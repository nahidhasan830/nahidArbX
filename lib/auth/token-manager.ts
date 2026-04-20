/**
 * Token Manager for Pinnacle via betjili
 *
 * Captures and manages Bearer tokens for Pinnacle API access.
 * Uses Playwright for browser automation to bypass Cloudflare.
 *
 * Token refresh flow:
 * 1. Try stored token (pinnacle-token.json) - check expiry
 * 2. Try stored Pinnacle URL (pinnacle-url.txt) - fastest if session valid
 * 3. Try browser session (browser-state.json) + click PINNACLE
 * 4. Full betjili login as last resort
 */

import { chromium, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import {
  closeSingletonBrowser,
  getSingletonBrowser,
  registerSingletonBrowser,
} from "@/lib/shared/playwright-singleton";

// Stable key for the hot-reload-safe browser registry. Without this
// every Next.js HMR reload would orphan a live Chromium process —
// we've seen the dev loop accumulate 130+ of these and push RAM
// into the tens of GB.
const BROWSER_KEY = "pinnacle.token-manager";

// File paths for persistence
const STATE_FILE = "sessions/betjili/browser-state.json";
const PINNACLE_URL_FILE = "sessions/betjili/pinnacle-url.txt";
const PINNACLE_TOKEN_FILE = "sessions/betjili/pinnacle-token.json";

// Proactive refresh threshold (refresh 20 mins before expiry)
const PROACTIVE_REFRESH_BUFFER_MS = 20 * 60 * 1000;

// Selectors
const SELECTORS = {
  loginPopup: ".popup-page-main--show",
  username: 'input[name="userId"]',
  password: 'input[name="password"]',
  pinnacle: '[vendor-code="AWCV2_PINNACLE"]',
};

export interface TokenData {
  token: string;
  refreshToken: string;
  capturedAt: string;
  expiresAt?: string;
}

// Browser ref lives on globalThis via the singleton registry; see
// BROWSER_KEY above. Do NOT reintroduce a module-local `browser` var —
// Next.js HMR would orphan it on every edit.

// Concurrency control - prevent multiple simultaneous browser launches
let isCapturing = false;
let capturePromise: Promise<TokenData | null> | null = null;

// ============================================
// Public API
// ============================================

/**
 * Get a valid Pinnacle token, refreshing if needed
 * @param forceRefresh - Force a new token capture even if current token appears valid
 * @param skipCapture - If true, return null instead of triggering slow browser capture (for fast refreshes)
 */
export async function getPinnacleToken(
  forceRefresh = false,
  skipCapture = false,
): Promise<string | null> {
  // Try stored token first (unless force refresh)
  if (!forceRefresh) {
    const storedToken = getStoredToken();
    if (storedToken && isTokenValid()) {
      return storedToken;
    }
  }

  // If skipCapture is true, don't trigger slow browser automation
  if (skipCapture) {
    return null;
  }

  // Need to refresh - run the capture flow
  const tokenData = await captureToken();
  return tokenData?.token || null;
}

/**
 * Check if stored token is still valid
 */
export function isTokenValid(): boolean {
  try {
    if (!fs.existsSync(PINNACLE_TOKEN_FILE)) return false;

    const data: TokenData = JSON.parse(
      fs.readFileSync(PINNACLE_TOKEN_FILE, "utf-8"),
    );
    if (!data.expiresAt) return true; // No expiry info, assume valid

    const expiresAt = new Date(data.expiresAt);
    const now = new Date();
    // Add 5 minute buffer before expiry
    const bufferMs = 5 * 60 * 1000;
    return expiresAt.getTime() - bufferMs > now.getTime();
  } catch {
    return false;
  }
}

/**
 * Get stored token without validation
 */
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

/**
 * Clear stored token (call this when token is confirmed invalid, e.g., 401)
 */
export function clearStoredToken(): void {
  try {
    if (fs.existsSync(PINNACLE_TOKEN_FILE)) {
      fs.unlinkSync(PINNACLE_TOKEN_FILE);
    }
  } catch {
    // ignore
  }
}

/**
 * Get time until token expires (in ms), or null if no token/no expiry info
 */
export function getTokenTTL(): number | null {
  try {
    if (!fs.existsSync(PINNACLE_TOKEN_FILE)) return null;
    const data: TokenData = JSON.parse(
      fs.readFileSync(PINNACLE_TOKEN_FILE, "utf-8"),
    );
    if (!data.expiresAt) return null;

    const expiresAt = new Date(data.expiresAt);
    const now = new Date();
    return expiresAt.getTime() - now.getTime();
  } catch {
    return null;
  }
}

/**
 * Check if token should be proactively refreshed (expiring within 20 mins)
 */
export function shouldRefreshProactively(): boolean {
  const ttl = getTokenTTL();
  if (ttl === null) return false;
  return ttl < PROACTIVE_REFRESH_BUFFER_MS && ttl > 0;
}

/**
 * Proactively refresh token if expiring soon
 * Non-blocking - logs but doesn't throw on failure
 */
export async function refreshTokenIfNeeded(): Promise<boolean> {
  if (!shouldRefreshProactively()) {
    return false;
  }

  try {
    const tokenData = await captureToken();
    if (tokenData) {
      return true;
    }
    console.warn(
      "[TokenManager] Proactive refresh failed - will retry on next sync",
    );
    return false;
  } catch (error) {
    console.error("[TokenManager] Proactive refresh error:", error);
    return false;
  }
}

/**
 * Close browser instance
 */
export async function closeBrowser(): Promise<void> {
  await closeSingletonBrowser(BROWSER_KEY);
}

// ============================================
// Token Capture Flow
// ============================================

// Stealth context options to avoid bot detection
const STEALTH_CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 1080 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function captureToken(): Promise<TokenData | null> {
  // Prevent concurrent captures - reuse existing promise if capture in progress
  if (isCapturing && capturePromise) {
    return capturePromise;
  }

  isCapturing = true;
  capturePromise = doCaptureToken();

  try {
    return await capturePromise;
  } finally {
    isCapturing = false;
    capturePromise = null;
  }
}

async function doCaptureToken(): Promise<TokenData | null> {
  const headless = process.env.TOKEN_HEADLESS !== "false"; // Default headless in production

  // Reuse an already-warm Chromium when the registry has one — keeps
  // repeated captures fast and, more importantly, guarantees any
  // previous orphan gets closed before we add a new one. On cold
  // launch we register the fresh instance so HMR / process exit can
  // tear it down cleanly.
  let browser = getSingletonBrowser(BROWSER_KEY);
  if (!browser) {
    browser = await chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    await registerSingletonBrowser(BROWSER_KEY, browser);
  } else {
    // HMR reload path — the Chromium is warm but carries leftover
    // contexts from the previous module lifetime. Close them so memory
    // inside the browser doesn't grow with every dev-server edit.
    for (const ctx of browser.contexts()) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
  }

  try {
    // STEP 1: Try stored Pinnacle URL directly.
    //
    // Short-circuit timeout: a stored URL that has gone stale (session
    // recycled on the betjili side) doesn't fail cleanly — the server
    // just hangs, and we waste the default 30s Playwright timeout on
    // every sync cycle before falling through. Cap at 10s so we get
    // to step 2 (cookie replay) quickly when the URL is dead.
    if (fs.existsSync(PINNACLE_URL_FILE)) {
      const storedUrl = fs.readFileSync(PINNACLE_URL_FILE, "utf-8").trim();

      const context = await browser.newContext(STEALTH_CONTEXT_OPTIONS);
      const page = await context.newPage();
      const tokenPromise = captureTokenFromPage(page);

      let storedUrlOk = false;
      try {
        await page.goto(storedUrl, { timeout: 10_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
        storedUrlOk = await isPinnaclePageValid(page);
      } catch {
        // navigation/domcontentloaded timed out — treat as stale and
        // fall through to step 2.
        storedUrlOk = false;
      }

      if (storedUrlOk) {
        const tokenData = await tokenPromise;
        await context.close();
        if (tokenData) {
          return tokenData;
        }
      } else {
        try {
          fs.unlinkSync(PINNACLE_URL_FILE);
        } catch {
          // already gone — ignore
        }
        await context.close();
      }
    }

    // STEP 2: Try browser session + click PINNACLE
    let context: BrowserContext;
    let needsLogin = false;

    if (fs.existsSync(STATE_FILE)) {
      context = await browser.newContext({
        ...STEALTH_CONTEXT_OPTIONS,
        storageState: STATE_FILE,
      });
    } else {
      context = await browser.newContext(STEALTH_CONTEXT_OPTIONS);
      needsLogin = true;
    }

    const page = await context.newPage();

    if (needsLogin) {
      await doFullLogin(context, page);
    } else {
      await page.goto("https://betjili365.com/bd/en");
      await page.waitForLoadState("domcontentloaded");

      if (page.url().includes("account-login")) {
        await doFullLogin(context, page);
      }
    }

    // Close popups and wait for UI to settle
    await closePopups(page);
    await page.waitForTimeout(500);

    // Scroll down to sports section where PINNACLE button is
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(500);

    // Click PINNACLE and capture token
    const tokenData = await clickPinnacleAndCaptureToken(context, page);

    // Handle session expiry during click
    if (!tokenData && page.url().includes("account-login")) {
      if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

      await doFullLogin(context, page);
      await closePopups(page);
      const retryToken = await clickPinnacleAndCaptureToken(context, page);
      await context.close();
      return retryToken;
    }

    await context.close();
    return tokenData;
  } catch (error) {
    console.error("[TokenManager] Error during token capture:", error);
    return null;
  } finally {
    await closeBrowser();
  }
}

// ============================================
// Helper Functions
// ============================================

async function doFullLogin(context: BrowserContext, page: Page): Promise<void> {
  const loginUrl =
    process.env.BETJILI_URL ||
    "https://betjili365.com/bd/en/account-login-quick";
  const username = process.env.BETJILI_USERNAME;
  const password = process.env.BETJILI_PASSWORD;

  if (!username || !password) {
    throw new Error("Set BETJILI_USERNAME and BETJILI_PASSWORD in .env.local");
  }

  // Navigate to login if not already there
  if (!page.url().includes("account-login")) {
    await page.goto(loginUrl);
  }

  // Wait for login popup
  await page.waitForSelector(SELECTORS.loginPopup, {
    state: "visible",
    timeout: 60000,
  });
  await page.waitForSelector(SELECTORS.username, {
    state: "visible",
    timeout: 10000,
  });
  await page.waitForSelector(SELECTORS.password, {
    state: "visible",
    timeout: 10000,
  });

  // Fill credentials (with backspace trick for Angular validation)
  await page.fill(SELECTORS.username, username);
  await page.type(SELECTORS.password, password, { delay: 50 });
  await page.press(SELECTORS.password, "Backspace");
  await page.waitForTimeout(300);
  await page.type(SELECTORS.password, password.slice(-1));
  await page.waitForTimeout(1000);

  // Submit
  await page.press(SELECTORS.password, "Enter");

  // Wait for redirect
  await page.waitForURL("https://betjili365.com/bd/en", { timeout: 60000 });

  // Save session
  await context.storageState({ path: STATE_FILE });

  // Reload to clear popups
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

async function closePopups(page: Page): Promise<void> {
  let count = 0;
  while (count < 10) {
    const overlay = page.locator(".cdk-overlay-container .pop-bg");
    const isVisible = await overlay.isVisible().catch(() => false);
    if (!isVisible) break;

    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    count++;
  }
}

async function clickPinnacleAndCaptureToken(
  context: BrowserContext,
  page: Page,
): Promise<TokenData | null> {
  const pinnacleBtn = page.locator(SELECTORS.pinnacle).first();

  try {
    await pinnacleBtn.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    if (page.url().includes("account-login")) {
      return null;
    }
    console.error(
      "[TokenManager] PINNACLE button not found on page:",
      page.url(),
    );
    return null;
  }

  try {
    const [newPage] = await Promise.all([
      context.waitForEvent("page", { timeout: 15000 }),
      pinnacleBtn.click(),
    ]);

    // Start token capture
    const tokenPromise = captureTokenFromPage(newPage);

    // Wait for Pinnacle page
    try {
      await newPage.waitForURL(
        (url) =>
          url.href.includes("pinnacleSports.jsp") ||
          url.href.includes("cc1ps") ||
          url.href.includes("cc2ps"),
        { timeout: 30000 },
      );
    } catch {
      // Timeout is OK, continue anyway
    }

    await newPage.waitForLoadState("domcontentloaded");
    const pinnacleUrl = newPage.url();

    // Save URL for future use
    if (pinnacleUrl.includes("sess=")) {
      fs.writeFileSync(PINNACLE_URL_FILE, pinnacleUrl);
    }

    // Wait for token (30s timeout in captureTokenFromPage)
    const tokenData = await tokenPromise;
    return tokenData;
  } catch (err) {
    if (page.url().includes("account-login")) return null;
    console.error("[TokenManager] Error clicking PINNACLE:", err);
    throw new Error("Failed to click PINNACLE");
  }
}

function captureTokenFromPage(page: Page): Promise<TokenData | null> {
  return new Promise((resolve) => {
    let resolved = false;

    page.on("response", async (response) => {
      if (resolved) return;

      const url = response.url();
      if (url.includes("/player/auth/authentication")) {
        try {
          const json = await response.json();
          if (json.success && json.data?.token) {
            const tokenData: TokenData = {
              token: json.data.token,
              refreshToken: json.data.refreshToken || "",
              capturedAt: new Date().toISOString(),
            };

            // Decode JWT for expiry
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
              /* ignore */
            }

            // Save to file
            fs.writeFileSync(
              PINNACLE_TOKEN_FILE,
              JSON.stringify(tokenData, null, 2),
            );

            resolved = true;
            resolve(tokenData);
          }
        } catch {
          /* ignore */
        }
      }
    });

    setTimeout(() => {
      if (!resolved) resolve(null);
    }, 30000);
  });
}

async function isPinnaclePageValid(page: Page): Promise<boolean> {
  await page.waitForTimeout(2000);
  const url = page.url();

  if (url.includes("/logout")) return false;
  if (
    !url.includes("pinnacleSports.jsp") &&
    !url.includes("cc1ps") &&
    !url.includes("cc2ps")
  ) {
    return false;
  }

  return true;
}
