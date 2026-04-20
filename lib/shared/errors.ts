/**
 * Shared Error Utilities
 *
 * Common error formatting functions used across adapters.
 */

import { isAxiosError } from "axios";

/**
 * Format an error for logging.
 * Handles Axios errors specially to extract status and response data.
 */
export function formatError(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response) {
      const { status, statusText, data } = error.response;
      return `${status} ${statusText}${data ? ` - ${JSON.stringify(data)}` : ""}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
