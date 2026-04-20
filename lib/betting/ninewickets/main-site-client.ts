/**
 * Playwright-backed HTTP client for 9wktsbest.com main-site calls.
 *
 * Why this exists — the main site sits behind Cloudflare with JA3/TLS
 * fingerprinting. Plain `fetch()` from Node (or curl) returns a 403
 * Cloudflare challenge page even with a valid JWT.
 *
 * IMPORTANT implementation detail — we make API calls via
 * `page.evaluate(async () => fetch(...))` on a persistent page
 * already navigated to 9wktsbest.com, NOT via Playwright's
 * `context.request`. The reason:
 *
 *   - `context.request` uses Node's HTTP stack under the hood (Node's
 *     fetch/http internals), so CF still sees Node's TLS fingerprint
 *     and blocks with a 403 challenge page.
 *   - `page.evaluate('fetch(...)')` runs inside Chromium's V8 + network
 *     stack, so the TLS handshake uses real BoringSSL / Chrome ciphers
 *     and CF's JA3 check passes.
 *
 * Tuning knobs (env):
 *   MAIN_SITE_CLIENT_HEADLESS   default "true"; "false" for debug
 *   MAIN_SITE_CLIENT_DISABLE    default "false"; "true" falls back to
 *                               raw fetch (will 403 — test-only)
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { logger } from "@/lib/shared/logger";
import {
  closeSingletonBrowser,
  getSingletonBrowser,
  registerSingletonBrowser,
} from "@/lib/shared/playwright-singleton";

// Hot-reload-safe browser registry key. Keeping the Browser ref on
// globalThis means every Next.js edit reuses the same Chromium (or
// cleanly disposes it) instead of spawning an orphan.
const BROWSER_KEY = "ninewickets.main-site";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BASE_URL = "https://9wktsbest.com";
const WARMUP_PATH = "/bd/en/EXSport";

interface PersistentClient {
  browser: Browser;
  context: BrowserContext;
  /**
   * A page kept alive on 9wktsbest.com so every fetch we issue
   * through `page.evaluate` runs with the right TLS + cookies.
   */
  page: Page;
  /** Timestamp of last successful request through the context. */
  lastUsed: number;
  /** Requests served. Rotate context if this ever grows unbounded. */
  served: number;
}

// HMR-safe module state. Without this, every code reload resets the
// module-level references while the Chromium page they pointed at keeps
// running in a previous module instance — the next request then runs
// through the stale cached reference and hits "Target page has been
// closed" because the new module's cleanup closed the old context.
// Storing on globalThis keeps the same client visible across HMR
// reloads; resetMainSiteClient() is the only way to drop it.
interface MainSiteClientGlobals {
  client: PersistentClient | null;
  inflightInit: Promise<PersistentClient> | null;
}
const GLOBALS_KEY = Symbol.for("nahidarbx.ninewickets.main-site-client");
type GlobalWithClient = typeof globalThis & {
  [GLOBALS_KEY]?: MainSiteClientGlobals;
};
function getGlobals(): MainSiteClientGlobals {
  const g = globalThis as GlobalWithClient;
  let s = g[GLOBALS_KEY];
  if (!s) {
    s = { client: null, inflightInit: null };
    g[GLOBALS_KEY] = s;
  }
  return s;
}

async function initClient(): Promise<PersistentClient> {
  const headless = process.env.MAIN_SITE_CLIENT_HEADLESS !== "false";
  // If a prior instance (before HMR reload, or a stale init) left a
  // Chromium running, reuse it — otherwise every edit would stack
  // another orphan. The client state itself (page/context) is
  // reinitialised either way since CF warm-up needs to run fresh.
  let browser = getSingletonBrowser(BROWSER_KEY);
  if (!browser) {
    browser = await chromium.launch({ headless });
    await registerSingletonBrowser(BROWSER_KEY, browser);
  } else {
    // HMR reload or stale prior init — the Chromium process is fine
    // but the contexts it's holding are from a previous module
    // lifetime. Close them before creating fresh ones so memory
    // inside the browser doesn't grow with every dev-server edit.
    for (const ctx of browser.contexts()) {
      try {
        await ctx.close();
      } catch {
        // ignore — context may already be closing
      }
    }
  }
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();
  try {
    // Warm up: navigate once so Cloudflare hands out the `cf_clearance`
    // cookie (and any JS-set challenge tokens). The page stays open for
    // the lifetime of the server process — every subsequent call runs
    // via page.evaluate(fetch(...)) so it shares this page's TLS and
    // cookie jar.
    await page.goto(BASE_URL + WARMUP_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Give CF's JS a moment to run its interstitial if any.
    await page.waitForTimeout(1500);
  } catch (err) {
    // Navigation hiccups (hash-only SPA routes, etc.) aren't fatal —
    // the origin is still loaded enough for fetch to succeed.
    logger.warn(
      "MainSiteClient",
      `warmup navigation partial: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    browser,
    context,
    page,
    lastUsed: Date.now(),
    served: 0,
  };
}

/**
 * Get the (lazily-initialised) shared client. Concurrent callers
 * during cold start share the same in-flight init promise.
 *
 * Transparently rebuilds the client when the cached Page is closed —
 * this covers HMR edge cases and Chromium crashes so callers don't
 * have to own the recovery logic.
 */
async function getClient(): Promise<PersistentClient> {
  const g = getGlobals();
  if (g.client && !g.client.page.isClosed()) return g.client;
  if (g.client && g.client.page.isClosed()) {
    // Stale cache — the page is gone. Drop it and fall through to
    // re-init. `resetMainSiteClient` is the canonical way to do this
    // but we can't await it here without inviting a loop; null the
    // ref and let initClient() reuse any still-warm Chromium.
    logger.warn(
      "MainSiteClient",
      "cached client has a closed page; rebuilding",
    );
    g.client = null;
  }
  if (g.inflightInit) return g.inflightInit;
  g.inflightInit = initClient()
    .then((c) => {
      g.client = c;
      logger.info(
        "MainSiteClient",
        "Chromium main-site client initialised (warmed via " +
          WARMUP_PATH +
          ")",
      );
      return c;
    })
    .finally(() => {
      g.inflightInit = null;
    });
  return g.inflightInit;
}

/**
 * Wipe the persistent browser — call when a request fails in a way
 * that suggests CF cookies have expired (e.g. repeated 403s after a
 * previously-working run). Next call will re-warm.
 */
export async function resetMainSiteClient(): Promise<void> {
  const g = getGlobals();
  const c = g.client;
  g.client = null;
  g.inflightInit = null;
  if (c) {
    try {
      await c.page.close().catch(() => {});
      await c.context.close();
    } catch {
      // ignore
    }
  }
  // Always go through the singleton registry so the Browser ref on
  // globalThis is cleared in lockstep with the local `client`. If we
  // leave the registry entry dangling, next init() will think
  // Chromium is still warm and skip launching a fresh one while the
  // local state is already gone.
  await closeSingletonBrowser(BROWSER_KEY);
}

export interface MainSiteFetchOptions {
  method: "GET" | "POST";
  path: string; // e.g. "/api/bt/v1/user/getPlayerInfo?..."
  jwt: string;
  body?: unknown; // JSON-encoded automatically for POST
  referer?: string;
  /** Per-request timeout in ms. Defaults to 10s. */
  timeoutMs?: number;
}

/**
 * Thrown when the main-site API rejects the request as unauthorized
 * (HTTP 401 or an envelope flagging the JWT as expired). The overview
 * route catches this to invalidate the session and retry once with a
 * fresh JWT before surfacing the failure to the operator.
 */
export class MainSiteAuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MainSiteAuthExpiredError";
  }
}

interface EvalArgs {
  url: string;
  method: "GET" | "POST";
  jwt: string;
  body: string | null;
  referer: string;
  timeoutMs: number;
}

interface EvalResult {
  status: number;
  body: string;
  error?: string;
}

/**
 * Do an HTTP request against 9wktsbest.com through the persistent
 * browser page. Returns the raw { status, body } so callers can
 * decide whether to parse JSON.
 */
export async function mainSiteFetch(
  opts: MainSiteFetchOptions,
): Promise<{ status: number; body: string }> {
  if (process.env.MAIN_SITE_CLIENT_DISABLE === "true") {
    // Escape hatch for tests — will 403 on CF, but keeps tests
    // isolated from the real browser.
    const res = await fetch(BASE_URL + opts.path, {
      method: opts.method,
      headers: buildNodeHeaders(opts),
      body:
        opts.method === "POST" && opts.body !== undefined
          ? JSON.stringify(opts.body)
          : undefined,
    });
    return { status: res.status, body: await res.text() };
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const args: EvalArgs = {
    url: BASE_URL + opts.path,
    method: opts.method,
    jwt: opts.jwt,
    body:
      opts.method === "POST" && opts.body !== undefined
        ? JSON.stringify(opts.body)
        : null,
    referer: opts.referer ?? BASE_URL + WARMUP_PATH,
    timeoutMs,
  };

  // Retry-once wrapper for the "persistent client went stale" failure
  // mode. The client holds a long-lived Page that can be closed by
  //   - HMR in dev (old module's page reference survives; Chromium
  //     closed its context when the new module ran initClient)
  //   - Chromium renderer crash
  //   - A racing resetMainSiteClient() call
  //   - Idle cleanup by the session layer
  // Whenever we detect that signature we wipe the client and rebuild
  // from scratch before returning an error. One retry is enough —
  // repeated "closed target" errors usually mean Chromium itself is
  // gone, at which point resetMainSiteClient + a fresh launch via
  // getClient() is exactly the recovery path we want.
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getClient();
    if (c.page.isClosed()) {
      // Defensive: if the cached client's page is already closed,
      // drop it and re-init on the next loop iteration.
      await resetMainSiteClient().catch(() => {});
      continue;
    }
    try {
      const result = await runEvaluate(c, args, timeoutMs);
      if (result.error) {
        throw new Error(
          `main-site fetch error (browser-side): ${result.error}`,
        );
      }
      c.lastUsed = Date.now();
      c.served += 1;
      return { status: result.status, body: result.body };
    } catch (err) {
      if (attempt === 0 && isRecoverableClientError(err)) {
        logger.warn(
          "MainSiteClient",
          `persistent client stale (${errMessage(err)}); resetting and retrying once`,
        );
        await resetMainSiteClient().catch(() => {});
        continue;
      }
      throw err;
    }
  }
  // Unreachable — the loop either returns or throws.
  throw new Error("main-site fetch: exhausted retry budget");
}

async function runEvaluate(
  c: PersistentClient,
  args: EvalArgs,
  timeoutMs: number,
): Promise<EvalResult> {
  // Two layers of timeout so a stuck call can't hang the route:
  //  (a) AbortController inside the page — cancels the in-browser fetch.
  //  (b) Promise.race outside — covers the Playwright IPC bridge itself
  //      going silent (has happened when the page crashed post-navigation).
  const evalPromise = c.page.evaluate<EvalResult, EvalArgs>(async (a) => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), a.timeoutMs);
    try {
      const res = await fetch(a.url, {
        method: a.method,
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Authorization: "Bearer " + a.jwt,
          "X-Internal-Request": "61405202",
          Referer: a.referer,
        },
        body: a.method === "POST" && a.body ? a.body : undefined,
        credentials: "include",
        signal: controller.signal,
      });
      const text = await res.text();
      return { status: res.status, body: text };
    } catch (err) {
      return {
        status: 0,
        body: "",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(tid);
    }
  }, args);

  return await Promise.race<EvalResult>([
    evalPromise,
    new Promise<EvalResult>((_, reject) =>
      setTimeout(
        () => reject(new Error(`evaluate timeout (${timeoutMs + 1000}ms)`)),
        timeoutMs + 1000,
      ),
    ),
  ]);
}

/**
 * True iff the error looks like "the cached Playwright client is no
 * longer usable" — closed page, closed context, killed browser,
 * disconnected IPC. These are recoverable by wiping the client and
 * rebuilding on the next `getClient()`.
 *
 * We match on message substrings rather than instance-of because
 * Playwright raises plain `Error`s with these exact prefixes; there
 * is no dedicated error class exported.
 */
function isRecoverableClientError(err: unknown): boolean {
  const m = errMessage(err).toLowerCase();
  return (
    m.includes("target page, context or browser has been closed") ||
    m.includes("target closed") ||
    m.includes("page has been closed") ||
    m.includes("context has been closed") ||
    m.includes("browser has been closed") ||
    m.includes("browser has disconnected") ||
    m.includes("execution context was destroyed") ||
    m.includes("page crashed") ||
    m.includes("evaluate timeout")
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Convenience: fetch + JSON.parse. Throws if the response is HTML
 * (CF challenge leaked through — call resetMainSiteClient to re-warm)
 * or non-2xx.
 */
export async function mainSiteFetchJson<T>(
  opts: MainSiteFetchOptions,
): Promise<T> {
  const { status, body } = await mainSiteFetch(opts);
  const trimmed = body.trim();
  if (trimmed.startsWith("<")) {
    // CF leak. Reset client so the next caller re-warms; don't retry
    // here to avoid tight loops.
    resetMainSiteClient().catch(() => {});
    throw new Error(
      `main-site ${opts.path} returned HTML (CF challenge; status ${status}). ` +
        `Client reset — next call will re-warm.`,
    );
  }
  if (status === 401 || status === 403) {
    throw new MainSiteAuthExpiredError(
      `main-site ${opts.path} HTTP ${status} — JWT likely expired`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(
      `main-site ${opts.path} HTTP ${status}: ${trimmed.slice(0, 200)}`,
    );
  }
  // Some main-site endpoints return HTTP 200 with a status envelope
  // like {"status":"99999","message":"login expired"} when the JWT
  // has aged out. Detect those so the caller can retry with a fresh
  // session — otherwise the error surfaces as an inscrutable envelope
  // parse later and the dashboard just shows "Couldn't load".
  const parsed = JSON.parse(trimmed) as unknown;
  if (isAuthExpiredEnvelope(parsed)) {
    throw new MainSiteAuthExpiredError(
      `main-site ${opts.path} auth-expired envelope: ${summariseEnvelope(parsed)}`,
    );
  }
  return parsed as T;
}

function isAuthExpiredEnvelope(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const env = parsed as { status?: unknown; message?: unknown };
  const status = typeof env.status === "string" ? env.status : null;
  const message =
    typeof env.message === "string" ? env.message.toLowerCase() : "";
  if (
    status === "1001" ||
    status === "40001" ||
    status === "99999" ||
    /login|token|auth|unauthori[sz]ed|expired/.test(message)
  ) {
    // Guard against false positives on happy-path envelopes that
    // happen to use string status — only treat as auth if the status
    // isn't the success sentinel.
    return status !== "0" && status !== "200";
  }
  return false;
}

function summariseEnvelope(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return String(parsed).slice(0, 80);
  const env = parsed as { status?: unknown; message?: unknown };
  return `${env.status ?? "?"} ${env.message ?? ""}`.trim().slice(0, 120);
}

/** Only used when MAIN_SITE_CLIENT_DISABLE=true (test escape hatch). */
function buildNodeHeaders(opts: MainSiteFetchOptions): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${opts.jwt}`,
    "Content-Type": "application/json",
    "User-Agent": UA,
    "X-Internal-Request": "61405202",
    Origin: BASE_URL,
    Referer: opts.referer ?? BASE_URL + WARMUP_PATH,
  };
}
