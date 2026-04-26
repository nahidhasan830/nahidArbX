/**
 * Capture a Set-Cookie value from a chain of HTTP redirects.
 *
 * Many betting platforms use the same SSO-bridge pattern: a "main"
 * tier mints a one-shot signed URL pointing at a "provider" tier;
 * fetching that URL returns 302 + `Set-Cookie: JSESSIONID=…` and
 * (sometimes) a follow-up redirect into the actual landing page.
 * `fetch()` with default redirect handling drops Set-Cookie info, so
 * we follow redirects manually and harvest the cookie at each hop.
 *
 * Used by:
 *   - lib/betting/velki/session.ts  (token → JSESSIONID handoff)
 *
 * Future use (worth migrating away from Playwright once verified):
 *   - lib/betting/ninewickets/session.ts  9W uses Playwright today;
 *     if its Cloudflare layer turns out not to actually require a real
 *     browser for the bridge step, we can drop Playwright there too
 *     using this same helper.
 */

interface CaptureCookieOptions {
  /** The signed/redirecting URL to follow. */
  startUrl: string;
  /** Cookie name to harvest (case-insensitive). e.g. "JSESSIONID". */
  cookieName: string;
  /**
   * Headers to send with each hop. Origin/Referer are typically
   * required; if omitted, requests will go out with default fetch
   * headers and may be silently rejected.
   */
  headers?: Record<string, string>;
  /** Max redirects to follow before giving up. Default 5. */
  maxHops?: number;
  /**
   * Label used in thrown errors (e.g. "Velki SSO bridge"). Helps
   * tell apart failures across different providers in logs.
   */
  label?: string;
}

/**
 * GET `startUrl` and follow redirects manually, returning the value
 * of the first Set-Cookie matching `cookieName`. Throws if the cookie
 * never appears within `maxHops`, or if any hop returns a hard error.
 */
export async function captureCookieFromRedirects(
  opts: CaptureCookieOptions,
): Promise<string> {
  const {
    startUrl,
    cookieName,
    headers = {},
    maxHops = 5,
    label = "SSO",
  } = opts;
  const cookieRegex = new RegExp(
    `${cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`,
    "i",
  );

  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml,*/*",
        ...headers,
      },
    });

    // Set-Cookie can land on any hop, including the final 200 page.
    // getSetCookie() (Node ≥ 19) returns all values; without it we'd
    // lose duplicates that combine into a single comma-joined string.
    const setCookies =
      (
        res.headers as unknown as { getSetCookie?: () => string[] }
      ).getSetCookie?.() ?? [];
    for (const cookie of setCookies) {
      const m = cookieRegex.exec(cookie);
      if (m) return m[1];
    }

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) break;
      url = new URL(next, url).toString();
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      // 2xx with no matching cookie — bridge failed silently.
      const body = await res.text().catch(() => "");
      throw new Error(
        `[${label}] ${res.status} but no ${cookieName} cookie ` +
          `(body preview: ${body.slice(0, 200)})`,
      );
    }
    throw new Error(`[${label}] HTTP ${res.status}`);
  }
  throw new Error(
    `[${label}] could not capture ${cookieName} after ${maxHops} redirects`,
  );
}
