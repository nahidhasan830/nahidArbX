
import { isAxiosError } from "axios";

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
