
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import { config } from "../../config";
import { getPinnacleToken, clearStoredToken } from "../../auth/token-manager";
import { createProviderClient } from "../../shared/http";


export const pinnacleClient = createProviderClient({
  baseURL: config.providers.pinnacle.baseUrl,
  timeout: 30000,
  headers: {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.5",
  },
});


export interface FetchResult<T> {
  data: T;
  token: string;
}

export interface FetchOptions extends Omit<
  AxiosRequestConfig,
  "url" | "headers"
> {
  fastMode?: boolean;
}

export async function fetchWithTokenRefresh<T = unknown>(
  url: string,
  options?: FetchOptions,
): Promise<FetchResult<T>> {
  const { fastMode, ...axiosOptions } = options || {};

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
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      clearStoredToken();

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

    throw error;
  }
}

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
