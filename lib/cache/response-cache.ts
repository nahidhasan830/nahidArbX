import { getStoreVersion } from "../atoms/store";
import { singleton } from "@/lib/util/singleton";

type CachedResponse = Record<string, unknown>;

const cache = singleton("response-cache:state", () => ({
  response: null as CachedResponse | null,
  responseAll: null as CachedResponse | null,
  atVersion: -1,
}));

export function getCachedResponse(
  includeAll = false,
): Record<string, unknown> | null {
  const currentVersion = getStoreVersion();

  if (cache.atVersion === currentVersion) {
    return includeAll ? cache.responseAll : cache.response;
  }

  return null;
}

export function setCachedResponse(
  data: Record<string, unknown>,
  includeAll = false,
): void {
  cache.atVersion = getStoreVersion();
  if (includeAll) {
    cache.responseAll = data;
  } else {
    cache.response = data;
  }
}

export function invalidateResponseCache(): void {
  cache.atVersion = -1;
  cache.response = null;
  cache.responseAll = null;
}

export function getResponseETag(): string {
  return `W/"v${getStoreVersion()}"`;
}

export function checkETag(request: Request): Response | null {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (!ifNoneMatch) return null;

  const currentETag = getResponseETag();
  const normalize = (t: string) => t.trim().replace(/^W\//, "");

  const clientTags = ifNoneMatch.split(",").map((t) => normalize(t));
  if (clientTags.includes(normalize(currentETag))) {
    return new Response(null, {
      status: 304,
      headers: { ETag: currentETag },
    });
  }

  return null;
}
