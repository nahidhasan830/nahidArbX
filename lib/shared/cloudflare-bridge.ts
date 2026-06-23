import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  closeSingletonBrowser,
  getSingletonBrowser,
  registerSingletonBrowser,
} from "@/lib/shared/playwright-singleton";
import {
  captureStarted,
  stepCompleted,
  stepFailed,
  captureSucceeded,
  captureFailed,
} from "@/lib/shared/session-diagnostics";


export type CaptureStep =
  | "cf-solve"
  | "login"
  | "game-url"
  | "provider-process";

export class BridgeCaptureError extends Error {
  readonly step: CaptureStep;
  readonly hard: boolean;

  constructor(step: CaptureStep, message: string, hard = false) {
    super(message);
    this.name = "BridgeCaptureError";
    this.step = step;
    this.hard = hard;
  }
}

export interface CloudflareBridgeConfig {
  browserKey: string;

  siteUrl: string;

  loginUrl: string;

  buildLoginBody: () => Record<string, unknown>;

  extractAccessToken: (json: unknown) => string | null;

  isHardLoginFailure?: (json: unknown) => boolean;

  gameUrlEndpoint?: string;

  buildGameUrlBody?: () => Record<string, unknown>;

  processGameUrlResult?: (
    json: unknown,
    accessToken: string,
    context: BrowserContext,
  ) => Promise<unknown | null>;

  cfWaitMs?: number;

  maxAttempts?: number;

  backoffMs?: number[];

  userAgent?: string;
}

export interface CaptureResult {
  accessToken: string;
  loginResponse?: unknown;
  providerData: unknown;
  attempts: number;
}

export interface CloudflareBridge {
  capture: () => Promise<CaptureResult>;
  shutdown: () => Promise<void>;
}


const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [0, 1500, 4000];


export function createCloudflareBridge(
  config: CloudflareBridgeConfig,
): CloudflareBridge {
  const ua = config.userAgent ?? DEFAULT_UA;
  const cfWaitMs = config.cfWaitMs ?? 3000;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = config.backoffMs ?? DEFAULT_BACKOFF_MS;

  let browserInflight: Promise<Browser> | null = null;

  async function getCaptureBrowser(): Promise<Browser> {
    const existing = getSingletonBrowser(config.browserKey);
    if (existing) {
      for (const ctx of existing.contexts()) {
        try {
          await ctx.close();
        } catch {
        }
      }
      return existing;
    }
    if (browserInflight) return browserInflight;

    const headless = process.env.TOKEN_HEADLESS !== "false";
    browserInflight = chromium
      .launch({
        headless,
        args: ["--disable-blink-features=AutomationControlled"],
      })
      .then(async (b) => {
        await registerSingletonBrowser(config.browserKey, b);
        return b;
      })
      .finally(() => {
        browserInflight = null;
      });
    return browserInflight;
  }

  async function disposeCaptureBrowser(): Promise<void> {
    browserInflight = null;
    await closeSingletonBrowser(config.browserKey);
  }


  async function doSingleCapture(): Promise<CaptureResult> {
    const browser = await getCaptureBrowser();
    let ctx: BrowserContext | null = null;

    try {
      ctx = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1920, height: 1080 },
      });
      const page = await ctx.newPage();

      let t0 = Date.now();
      try {
        await page.goto(config.siteUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15000,
        });
        await page.waitForTimeout(cfWaitMs);
        stepCompleted(config.browserKey, "cf-solve", Date.now() - t0);
      } catch (err) {
        const msg = `[${config.browserKey}] CF navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        stepFailed(config.browserKey, "cf-solve", msg, Date.now() - t0);
        throw new BridgeCaptureError("cf-solve", msg);
      }

      let loginBody: Record<string, unknown>;
      try {
        loginBody = config.buildLoginBody();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stepFailed(config.browserKey, "login", msg);
        throw new BridgeCaptureError("login", msg, true);
      }

      t0 = Date.now();
      const loginResult = await inPagePost(page, config.loginUrl, loginBody);

      if (loginResult.status !== 200 || !loginResult.json) {
        const msg = `[${config.browserKey}] login HTTP ${loginResult.status} — ${loginResult.error ?? "no JSON"}`;
        stepFailed(config.browserKey, "login", msg, Date.now() - t0);
        throw new BridgeCaptureError("login", msg);
      }

      if (config.isHardLoginFailure?.(loginResult.json)) {
        const msg = `[${config.browserKey}] login refused (hard failure)`;
        stepFailed(config.browserKey, "login", msg, Date.now() - t0);
        throw new BridgeCaptureError("login", msg, true);
      }

      const accessToken = config.extractAccessToken(loginResult.json);
      if (!accessToken) {
        const msg = `[${config.browserKey}] login response did not include accessToken`;
        stepFailed(config.browserKey, "login", msg, Date.now() - t0);
        throw new BridgeCaptureError("login", msg);
      }
      stepCompleted(config.browserKey, "login", Date.now() - t0);

      if (!config.gameUrlEndpoint) {
        return {
          accessToken,
          loginResponse: loginResult.json,
          providerData: { loginResponse: loginResult.json },
          attempts: 0 ,
        };
      }
      if (!config.buildGameUrlBody || !config.processGameUrlResult) {
        const msg = `[${config.browserKey}] game-url config is incomplete`;
        stepFailed(config.browserKey, "game-url", msg);
        throw new BridgeCaptureError("game-url", msg, true);
      }

      t0 = Date.now();
      const gameResult = await inPagePost(
        page,
        config.gameUrlEndpoint,
        config.buildGameUrlBody(),
        { Authorization: `Bearer ${accessToken}` },
      );

      if (gameResult.status !== 200 || !gameResult.json) {
        const msg = `[${config.browserKey}] getGameUrl HTTP ${gameResult.status} — ${gameResult.error ?? "no JSON"}`;
        stepFailed(config.browserKey, "game-url", msg, Date.now() - t0);
        throw new BridgeCaptureError("game-url", msg);
      }
      stepCompleted(config.browserKey, "game-url", Date.now() - t0);

      t0 = Date.now();
      const providerData = await config.processGameUrlResult(
        gameResult.json,
        accessToken,
        ctx,
      );

      if (providerData === null || providerData === undefined) {
        const msg = `[${config.browserKey}] processGameUrlResult returned null`;
        stepFailed(config.browserKey, "provider-process", msg, Date.now() - t0);
        throw new BridgeCaptureError("provider-process", msg);
      }
      stepCompleted(config.browserKey, "provider-process", Date.now() - t0);

      return {
        accessToken,
        loginResponse: loginResult.json,
        providerData,
        attempts: 0 ,
      };
    } finally {
      if (ctx) {
        try {
          await ctx.close();
        } catch {
        }
      }
      await disposeCaptureBrowser();
    }
  }


  async function captureWithRetries(): Promise<CaptureResult> {
    let lastErr: unknown;

    captureStarted(config.browserKey);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delay = backoffMs[attempt] ?? backoffMs[backoffMs.length - 1] ?? 0;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        const result = await doSingleCapture();
        result.attempts = attempt + 1;
        captureSucceeded(config.browserKey);
        return result;
      } catch (err) {
        lastErr = err;

        if (err instanceof BridgeCaptureError && err.hard) {
          captureFailed(config.browserKey, err.message);
          throw err;
        }

        const step =
          err instanceof BridgeCaptureError ? ` (step: ${err.step})` : "";
        console.warn(
          `[${config.browserKey}] capture attempt ${attempt + 1}/${maxAttempts} failed${step}: ${err instanceof Error ? err.message : String(err)}`,
        );

        if (attempt + 1 < maxAttempts) {
          captureStarted(config.browserKey);
        }
      }
    }

    const finalMsg =
      lastErr instanceof Error ? lastErr.message : String(lastErr);
    captureFailed(config.browserKey, finalMsg);

    throw (
      lastErr ??
      new Error(
        `[${config.browserKey}] capture failed after ${maxAttempts} attempts`,
      )
    );
  }


  let inflight: Promise<CaptureResult> | null = null;

  return {
    capture: () => {
      if (inflight) return inflight;
      inflight = captureWithRetries().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    shutdown: () => disposeCaptureBrowser(),
  };
}


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
