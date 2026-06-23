
interface CaptureCookieOptions {
  startUrl: string;
  cookieName: string;
  headers?: Record<string, string>;
  maxHops?: number;
  label?: string;
}

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
