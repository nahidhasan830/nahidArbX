/**
 * Dev-only: trigger the live-strategy matcher on demand.
 * Useful to verify Phase 3 wiring without waiting for the next 30s sync cycle.
 */
import {
  apiError,
  apiServerError,
  apiSuccess,
} from "@/lib/shared/api-response";
import { runStrategyMatcher } from "@/lib/background/strategy-matcher";

export async function POST() {
  if (process.env.NODE_ENV !== "development") {
    return apiError("dev-only endpoint", 403);
  }
  try {
    const result = await runStrategyMatcher();
    return apiSuccess(result);
  } catch (err) {
    return apiServerError(err, "Backtest:run-matcher");
  }
}
