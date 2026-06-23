
import axios, { type AxiosInstance } from "axios";

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
