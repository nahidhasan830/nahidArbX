/**
 * Shared HTTP Client Factory
 *
 * Standardized axios instance creation for provider adapters.
 */

import axios, { type AxiosInstance } from "axios";

/**
 * Create a pre-configured axios client for a provider.
 *
 * @param config.baseURL - Base URL for the API
 * @param config.timeout - Request timeout in ms (default: 15000)
 * @param config.contentType - Content type: "json" or "form-urlencoded" (default: "json")
 * @param config.headers - Additional headers to merge
 */
export function createProviderClient(config: {
  baseURL?: string;
  timeout?: number;
  contentType?: "json" | "form-urlencoded";
  headers?: Record<string, string>;
}): AxiosInstance {
  const contentType =
    config.contentType === "form-urlencoded"
      ? "application/x-www-form-urlencoded"
      : "application/json";

  return axios.create({
    baseURL: config.baseURL,
    timeout: config.timeout ?? 15000,
    headers: {
      "Content-Type": contentType,
      Accept: "application/json",
      ...config.headers,
    },
  });
}
