/**
 * Token Manager for pslive via betjili
 *
 * Captures and manages Bearer tokens for pslive API access.
 * Uses Playwright for browser automation to bypass Cloudflare.
 *
 * Token refresh flow:
 * 1. Try stored token (pslive-token.json) - check expiry
 * 2. Try stored pslive URL (pslive-url.txt) - fastest if session valid
 * 3. Try browser session (browser-state.json) + click PINNACLE
 * 4. Full betjili login as last resort
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";

// File paths for persistence
const STATE_FILE = "browser-state.json";
const PSLIVE_URL_FILE = "pslive-url.txt";
const PSLIVE_TOKEN_FILE = "pslive-token.json";

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

let browser: Browser | null = null;

// ============================================
// Public API
// ============================================

/**
 * Get a valid pslive token, refreshing if needed
 * @param forceRefresh - Force a new token capture even if current token appears valid
 */
export async function getPsliveToken(forceRefresh = false): Promise<string | null> {
  // Try stored token first (unless force refresh)
  if (!forceRefresh) {
    const storedToken = getStoredToken();
    if (storedToken && isTokenValid()) {
      return storedToken;
    }
  }

  // Need to refresh - run the capture flow
  console.log("[TokenManager] Refreshing token...");
  const tokenData = await captureToken();
  return tokenData?.token || null;
}

/**
 * Check if stored token is still valid
 */
export function isTokenValid(): boolean {
  try {
    if (!fs.existsSync(PSLIVE_TOKEN_FILE)) return false;

    const data: TokenData = JSON.parse(fs.readFileSync(PSLIVE_TOKEN_FILE, "utf-8"));
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
    if (!fs.existsSync(PSLIVE_TOKEN_FILE)) return null;
    const data: TokenData = JSON.parse(fs.readFileSync(PSLIVE_TOKEN_FILE, "utf-8"));
    return data.token;
  } catch {
    return null;
  }
}

/**
 * Close browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    console.log("[TokenManager] Browser closed");
  }
}

// ============================================
// Token Capture Flow
// ============================================

// Stealth context options to avoid bot detection
const STEALTH_CONTEXT_OPTIONS = {
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

async function captureToken(): Promise<TokenData | null> {
  const headless = process.env.TOKEN_HEADLESS !== "false"; // Default headless in production
  browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    // STEP 1: Try stored pslive URL directly
    if (fs.existsSync(PSLIVE_URL_FILE)) {
      const storedUrl = fs.readFileSync(PSLIVE_URL_FILE, "utf-8").trim();
      console.log("[TokenManager] Trying stored pslive URL...");

      const context = await browser.newContext(STEALTH_CONTEXT_OPTIONS);
      const page = await context.newPage();
      const tokenPromise = captureTokenFromPage(page);

      await page.goto(storedUrl);
      await page.waitForLoadState("domcontentloaded");

      if (await isPslivePageValid(page)) {
        console.log("[TokenManager] Stored URL valid, capturing token...");
        const tokenData = await tokenPromise;
        await context.close();
        if (tokenData) return tokenData;
      } else {
        console.log("[TokenManager] Stored URL expired");
        fs.unlinkSync(PSLIVE_URL_FILE);
        await context.close();
      }
    }

    // STEP 2: Try browser session + click PINNACLE
    let context: BrowserContext;
    let needsLogin = false;

    if (fs.existsSync(STATE_FILE)) {
      console.log("[TokenManager] Trying saved browser session...");
      context = await browser.newContext({ ...STEALTH_CONTEXT_OPTIONS, storageState: STATE_FILE });
    } else {
      console.log("[TokenManager] No saved session, will login...");
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
        console.log("[TokenManager] Session expired, logging in...");
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
      console.log("[TokenManager] Session expired during click, re-logging in...");
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
  const loginUrl = process.env.BETJILI_URL || "https://betjili365.com/bd/en/account-login-quick";
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
  await page.waitForSelector(SELECTORS.loginPopup, { state: "visible", timeout: 60000 });
  await page.waitForSelector(SELECTORS.username, { state: "visible", timeout: 10000 });
  await page.waitForSelector(SELECTORS.password, { state: "visible", timeout: 10000 });

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
  console.log("[TokenManager] Login successful");

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
  page: Page
): Promise<TokenData | null> {
  console.log("[TokenManager] Looking for PINNACLE button...");
  const pinnacleBtn = page.locator(SELECTORS.pinnacle).first();

  try {
    await pinnacleBtn.waitFor({ state: "visible", timeout: 15000 });
    console.log("[TokenManager] PINNACLE button found");
  } catch {
    if (page.url().includes("account-login")) {
      console.log("[TokenManager] Redirected to login page");
      return null;
    }
    console.error("[TokenManager] PINNACLE button not found on page:", page.url());
    return null;
  }

  try {
    const [newPage] = await Promise.all([
      context.waitForEvent("page", { timeout: 15000 }),
      pinnacleBtn.click(),
    ]);

    // Start token capture
    const tokenPromise = captureTokenFromPage(newPage);

    // Wait for pslive page
    try {
      await newPage.waitForURL(
        (url) => url.href.includes("pinnacleSports.jsp") || url.href.includes("cc1ps") || url.href.includes("cc2ps"),
        { timeout: 30000 }
      );
    } catch {
      console.log("[TokenManager] Redirect timeout");
    }

    await newPage.waitForLoadState("domcontentloaded");
    const psliveUrl = newPage.url();

    // Save URL for future use
    if (psliveUrl.includes("sess=")) {
      fs.writeFileSync(PSLIVE_URL_FILE, psliveUrl);
    }

    // Wait for token
    const tokenData = await tokenPromise;
    return tokenData;
  } catch {
    if (page.url().includes("account-login")) return null;
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
                Buffer.from(json.data.token.replace("Bearer ", "").split(".")[1], "base64").toString()
              );
              if (payload.exp) {
                tokenData.expiresAt = new Date(payload.exp * 1000).toISOString();
              }
            } catch { /* ignore */ }

            // Save to file
            fs.writeFileSync(PSLIVE_TOKEN_FILE, JSON.stringify(tokenData, null, 2));
            console.log("[TokenManager] Token captured, expires:", tokenData.expiresAt || "unknown");

            resolved = true;
            resolve(tokenData);
          }
        } catch { /* ignore */ }
      }
    });

    setTimeout(() => {
      if (!resolved) resolve(null);
    }, 30000);
  });
}

async function isPslivePageValid(page: Page): Promise<boolean> {
  await page.waitForTimeout(2000);
  const url = page.url();

  if (url.includes("/logout")) return false;
  if (!url.includes("pinnacleSports.jsp") && !url.includes("cc1ps") && !url.includes("cc2ps")) {
    return false;
  }

  return true;
}
