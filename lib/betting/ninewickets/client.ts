import { getSession, invalidateSession } from "./session";
import type { NineWicketsSession, PlayerInfoResponse } from "./types";

const HOST_READ = "https://gakvx.seofmi.live";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://9wktsbest.com",
  Referer: "https://9wktsbest.com/",
  "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8", "Brave";v="147"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

export async function queryPlayerInfo(): Promise<PlayerInfoResponse> {
  return callWithSessionRetry(async (session) => {
    const url = `${HOST_READ}/exchange/member/playerService/queryPlayerInfo;jsessionid=${session.queryPass}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.queryPass,
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpiredError(`queryPlayerInfo ${res.status}`);
    }
    if (!res.ok) {
      throw new Error(`queryPlayerInfo failed: ${res.status}`);
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("<")) {
      throw new SessionExpiredError("queryPlayerInfo returned HTML");
    }
    if (trimmed.length === 0) {
      throw new SessionExpiredError("queryPlayerInfo returned empty body");
    }
    const parsed = JSON.parse(trimmed) as
      | PlayerInfoResponse
      | { status?: string; desc?: string };
    if (
      typeof (parsed as { status?: unknown }).status === "string" &&
      (parsed as { status: string }).status !== "0"
    ) {
      const errEnv = parsed as { status: string; desc?: string };
      const unauthorized =
        errEnv.status === "1001" ||
        (errEnv.desc ?? "").toLowerCase().includes("not authorized");
      if (unauthorized) {
        throw new SessionExpiredError(
          `queryPlayerInfo not authorized (${errEnv.status})`,
        );
      }
      throw new Error(
        `queryPlayerInfo returned error envelope: ${errEnv.status} ${errEnv.desc ?? ""}`,
      );
    }
    return parsed as PlayerInfoResponse;
  });
}


export class SessionExpiredError extends Error {}

export async function callWithSessionRetry<T>(
  fn: (session: NineWicketsSession) => Promise<T>,
): Promise<T> {
  const session = await getSession();
  try {
    return await fn(session);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      invalidateSession();
      const fresh = await getSession(true);
      return fn(fresh);
    }
    throw err;
  }
}
