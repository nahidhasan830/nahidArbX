/**
 * Shared Validation Utilities
 *
 * Reusable Zod safeParse wrapper for consistent validation and error logging.
 */

import type { z } from "zod";
import { logger } from "./logger";

/**
 * Validate and parse data against a Zod schema.
 * Logs errors with context on failure.
 *
 * @param data - Raw data to validate
 * @param schema - Zod schema to validate against
 * @param context - Human-readable context for error messages (e.g., "[Pinnacle] events response")
 * @returns Parsed data on success, null on failure
 */
export function validateAndParse<T>(
  data: unknown,
  schema: z.ZodType<T>,
  context: string,
): T | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    logger.error(
      "Validation",
      `${context}: invalid response - ${result.error.message}`,
    );
    return null;
  }
  return result.data;
}
