/**
 * Cloudflare Bridge — reusable session-capture pipeline.
 *
 * Many providers sit behind Cloudflare and share the same auth flow:
 *
 *   Step 0 – Navigate to the provider site → CF solves automatically
 *   Step 1 – page.evaluate(fetch('/login'))      → accessToken
 *   Step 2 – page.evaluate(fetch('/getGameUrl')) → provider-specific result
 *   Step 3 – (optional) Follow the result (navigate, redirect-capture, etc.)
 *
 * This module extracts the shared mechanics (warm browser management,
 * CF solving, in-page fetch, concurrency guards, retry with auto-healing)
 * into a reusable pipeline. Each provider plugs in a small config object
 * describing its endpoints and payload shapes.
 *
 * Failure handling:
 *   - Each step throws a typed BridgeCaptureError with a `step` field
 *   - Hard failures (bad credentials, account suspended) abort immediately
 *   - Transient failures (CF timeout, network blip, server 500) retry
 *     with backoff (3 attempts by default)
 *   - On any browser-level failure, the warm browser is disposed and
 *     relaunched fresh on the next attempt (auto-healing)
 *
 * Current consumers:
 *   - lib/auth/token-manager.ts         (Pinnacle)
 *   - lib/betting/ninewickets/session.ts (9W Sportsbook)
 *
 * Adding a new provider:
 *   1. Define a CloudflareBridgeConfig with your endpoints + payloads
 *   2. Call createCloudflareBridge(config) to get a { capture, shutdown } object
 *   3. Wire the capture result into your session type
 */
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  closeSingletonBrowser,
  getSingletonBrowser,
  registerSingletonBrowser,
} from "@/lib/shared/playwright-singleton";

// ── Types ────────────────────────────────────────────────────────────────

export type CaptureStep = "cf-solve" | "login" | "game-url" | "provider-process";

export class BridgeCaptureError extends Error {
  /** Which step of the pipeline failed. */
  readonly step: CaptureStep;
  /** True when the failure is permanent (bad creds, account locked). */
  readonly hard: boolean;

  constructor(step: CaptureStep, message: string, hard = false) {
    super(message);
    this.name = "BridgeCaptureError";
    this.step = step;
    this.hard = hard;
  }
}

export interface CloudflareBridgeConfig {
  /** Unique key for the playwright-singleton registry (e.g. "pinnacle", "ninewickets"). */
  browserKey: string;

  /** URL to navigate to for solving the CF challenge. */
  siteUrl: string;

  /** Login endpoint (called via page.evaluate(fetch())). */
  loginUrl: string;

  /** Build the login request body. Called once per capture. */
  buildLoginBody: () => Record<string, unknown>;

  /** Extract the auth token from the login JSON response. Return null on failure. */
  extractAccessToken: (json: unknown) => string | null;

  /**
   * Optional: classify a login response as a hard failure (bad creds,
   * account suspended). When true, retries are skipped. Default: never hard.
   */
  isHardLoginFailure?: (json: unknown) => boolean;

  /** Game-URL / provider-launch endpoint. */
  gameUrlEndpoint: string;

  /** Build the getGameUrl request body. */
  buildGameUrlBody: () => Record<string, unknown>;

  /**
   * Process the getGameUrl response and (optionally) the browser context
   * to produce the final capture result. This is where provider-specific
   * logic lives:
   *   - 9W: the gameUrl IS the jsessionid — just return it
   *   - Pinnacle: navigate to gameUrl in a new tab, intercept the auth response
   *
   * @param json        Parsed JSON from the getGameUrl response
   * @param accessToken The token from step 1
   * @param context     The browser context (for providers that need to navigate)
   * @returns The provider-specific result, or null on failure
   */
  processGameUrlResult: (
    json: unknown,
    accessToken: string,
    context: BrowserContext,
  ) => Promise<unknown | null>;

  /** Milliseconds to wait after CF page load. Default 3000. */
  cfWaitMs?: number;

  /** Max capture attempts (including the first). Default 3. */
  maxAttempts?: number;

  /** Backoff delays between attempts (ms). Default [0, 1500, 4000]. */
  backoffMs?: number[];

  /** User-Agent string. Uses a sensible Chrome default if omitted. */
  userAgent?: string;
}

export interface CaptureResult {
  accessToken: string;
  /** Provider-specific data returned by processGameUrlResult. */
  providerData: unknown;
  /** How many attempts it took (1 = first try). */
  attempts: number;
}

export interface CloudflareBridge {
  /** Run the full capture flow with retries. Coalesces concurrent callers. */
  capture: () => Promise<CaptureResult>;
  /** Shut down the warm browser. */
  shutdown: () => Promise<void>;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [0, 1500, 4000];

// ── Factory ──────────────────────────────────────────────────────────────

export function createCloudflareBridge(
  config: CloudflareBridgeConfig,
): CloudflareBridge {
  const ua = config.userAgent ?? DEFAULT_UA;
  const cfWaitMs = config.cfWaitMs ?? 3000;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;

  // Module-local inflight promise for coalescing concurrent callers
  // during cold-launch. The browser itself lives in the global registry.
  let warmBrowserInflight: Promise<Browser> | null = null;

  async function getWarmBrowser(): Promise<Browser> {
    const existing = getSingletonBrowser(config.browserKey);
    if (existing) {
      // HMR reload path: close stale contexts from prior module lifetimes
      for (const ctx of existing.contexts()) {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
      return existing;
    }
    if (warmBrowserInflight) return warmBrowserInflight;

    const headless = process.env.TOKEN_HEADLESS !== "false";
    warmBrowserInflight = chromium
      .launch({
        headless,
        args: ["--disable-blink-features=AutomationControlled"],
      })
      .then(async (b) => {
        await registerSingletonBrowser(config.browserKey, b);
        return b;
      })
      .finally(() => {
        warmBrowserInflight = null;
      });
    return warmBrowserInflight;
  }

  async function disposeWarmBrowser(): Promise<void> {
    warmBrowserInflight = null;
    await closeSingletonBrowser(config.browserKey);
  }

  // ── Single attempt ─────────────────────────────────────────────────

  async function doSingleCapture(): Promise<CaptureResult> {
    const browser = await getWarmBrowser();
    let ctx: BrowserContext | null = null;

    try {
      ctx = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1920, height: 1080 },
      });
      const page = await ctx.newPage();

      // ── Step 0: Solve Cloudflare ───────────────────────────────────
      try {
        await page.goto(config.siteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await page.waitForTimeout(cfWaitMs);
      } catch (err) {
        throw new BridgeCaptureError(
          "cf-solve",
          `[${config.browserKey}] CF navigation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── Step 1: Login via in-page fetch ────────────────────────────
      let loginBody: Record<string, unknown>;
      try {
        loginBody = config.buildLoginBody();
      } catch (err) {
        // Missing env vars = hard failure, no point retrying
        throw new BridgeCaptureError(
          "login",
          err instanceof Error ? err.message : String(err),
          true,
        );
      }

      const loginResult = await inPagePost(page, config.loginUrl, loginBody);

      if (loginResult.status !== 200 || !loginResult.json) {
        // HTTP 403 from the API usually means CF cookies expired mid-session
        // (transient); other errors may be transient too. Let retry handle it.
        throw new BridgeCaptureError(
          "login",
          `[${config.browserKey}] login HTTP ${loginResult.status} — ${loginResult.error ?? "no JSON"}`,
        );
      }

      // Check for hard login failures (bad creds, account suspended)
      if (config.isHardLoginFailure?.(loginResult.json)) {
        throw new BridgeCaptureError(
          "login",
          `[${config.browserKey}] login refused (hard failure)`,
          true,
        );
      }

      const accessToken = config.extractAccessToken(loginResult.json);
      if (!accessToken) {
        throw new BridgeCaptureError(
          "login",
          `[${config.browserKey}] login response did not include accessToken`,
        );
      }

      // ── Step 2: getGameUrl via in-page fetch ───────────────────────
      const gameResult = await inPagePost(
        page,
        config.gameUrlEndpoint,
        config.buildGameUrlBody(),
        { Authorization: `Bearer ${accessToken}` },
      );

      if (gameResult.status !== 200 || !gameResult.json) {
        throw new BridgeCaptureError(
          "game-url",
          `[${config.browserKey}] getGameUrl HTTP ${gameResult.status} — ${gameResult.error ?? "no JSON"}`,
        );
      }

      // ── Step 3: Provider-specific processing ───────────────────────
      const providerData = await config.processGameUrlResult(
        gameResult.json,
        accessToken,
        ctx,
      );

      if (providerData === null || providerData === undefined) {
        throw new BridgeCaptureError(
          "provider-process",
          `[${config.browserKey}] processGameUrlResult returned null`,
        );
      }

      return { accessToken, providerData, attempts: 0 /* set by caller */ };
    } catch (err) {
      // Any capture failure taints the warm browser — reset so the
      // next attempt starts with a clean Chromium process (auto-heal).
      await disposeWarmBrowser();
      throw err;
    } finally {
      if (ctx) {
        try {
          await ctx.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Retry wrapper ──────────────────────────────────────────────────

  async function captureWithRetries(): Promise<CaptureResult> {
    let lastErr: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Backoff before retry (first attempt is immediate)
      const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const result = await doSingleCapture();
        result.attempts = attempt + 1;
        return result;
      } catch (err) {
        lastErr = err;

        // Hard failures (bad credentials, missing env vars) — don't retry
        if (err instanceof BridgeCaptureError && err.hard) {
          throw err;
        }

        // Log transient failure and continue to next attempt
        const step =
          err instanceof BridgeCaptureError ? ` (step: ${err.step})` : "";
        console.warn(
          `[${config.browserKey}] capture attempt ${attempt + 1}/${maxAttempts} failed${step}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    throw lastErr ?? new Error(`[${config.browserKey}] capture failed after ${maxAttempts} attempts`);
  }

  // ── Coalesce concurrent capture calls ──────────────────────────────

  let inflight: Promise<CaptureResult> | null = null;

  return {
    capture: () => {
      if (inflight) return inflight;
      inflight = captureWithRetries().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    shutdown: () => disposeWarmBrowser(),
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────

/** Run a POST via fetch() inside the browser page (shares TLS + CF cookies). */
export async function inPagePost(
  page: Page,
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: unknown | null; error: string | null }> {
  return page.evaluate(
    async ({ url, body, extraHeaders }) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        });
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("json")) {
          return { status: res.status, json: await res.json(), error: null };
        }
        return {
          status: res.status,
          json: null,
          error: (await res.text()).slice(0, 300),
        };
      } catch (err) {
        return { status: 0, json: null, error: String(err) };
      }
    },
    { url, body, extraHeaders: extraHeaders || {} },
  );
}
