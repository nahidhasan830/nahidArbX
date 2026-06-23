
import type { z } from "zod";
import { logger } from "./logger";

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
