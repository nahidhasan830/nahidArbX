/**
 * Pinnacle API Client
 *
 * Shared axios client and helper functions for making authenticated requests.
 * Includes automatic 401 retry with token refresh.
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { config } from "../../config";
import { getPinnacleToken, clearStoredToken } from "../../auth/token-manager";
import { createProviderClient } from "../../shared/http";

// ============================================================
// Axios Client
// ============================================================

export const pinnacleClient = createProviderClient({
  baseURL: config.providers.pinnacle.baseUrl,
  timeout: 30000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
  },
});

// ============================================================
// Request Helpers
// ============================================================

export interface FetchResult<T> {
  data: T;
  token: string;
}

export interface FetchOptions extends Omit<
  AxiosRequestConfig,
  "url" | "headers"
> {
  /** If true, skip slow browser token capture - fail fast if token expired */
  fastMode?: boolean;
}

/**
 * Fetch with automatic 401 retry and token refresh.
 *
 * @param url - URL path (relative to baseURL)
 * @param options - Additional axios config options + fastMode flag
 * @returns Response data and the token used (for subsequent requests)
 * @throws Error if both attempts fail
 */
export async function fetchWithTokenRefresh<T = unknown>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  const { fastMode, ...axiosOptions } = options || {};

  // Get initial token (skip slow capture in fast mode)
  const token = await getPinnacleToken(false, fastMode);
  if (!token) {
    throw new Error(
      fastMode
        ? "Pinnacle token expired (fast mode)"
        : "No valid Pinnacle token available",
    );
  }

  try {
    const response = await pinnacleClient.get<T>(url, {
      ...axiosOptions,
      headers: { Authorization: token },
    });
    return { data: response.data, token };
  } catch (error) {
    // On 401, force token refresh and retry once (but skip capture in fast mode)
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      clearStoredToken(); // Clear the invalid cached token

      if (fastMode) {
        throw new Error("Pinnacle token expired (fast mode)");
      }
      const freshToken = await getPinnacleToken(true);
      if (!freshToken) {
        throw new Error("Token expired and refresh failed");
      }

      const retryResponse = await pinnacleClient.get<T>(url, {
        ...axiosOptions,
        headers: { Authorization: freshToken },
      });
      return { data: retryResponse.data, token: freshToken };
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Make an authenticated GET request (no automatic retry).
 * Use this when you want to handle 401 yourself.
 */
export async function fetchWithToken<T = unknown>(
  url: string,
  token: string,
  options?: Omit<AxiosRequestConfig, "url" | "headers">,
): Promise<AxiosResponse<T>> {
  return pinnacleClient.get<T>(url, {
    ...options,
    headers: { Authorization: token },
  });
}
